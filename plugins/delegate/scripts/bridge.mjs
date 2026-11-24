#!/usr/bin/env node
// The plugin's Node half. The hooks module (hooks/register.ts) runs inside Claude Code
// with no Node of its own, and a backend needs a process that holds a JSON-RPC
// conversation over stdio, so the module starts this script for each delegate turn.
//
//   bridge.mjs run              one turn. The request comes as JSON on stdin, which is
//                               then closed. Events go out as JSON lines on stdout.
//   bridge.mjs models [backend] the models each backend accepts, as text
//   bridge.mjs setup            whether Node and each backend's CLI are ready, as text
//   bridge.mjs status [turn]    the turns on record for this workspace, or one of them with
//                               the last lines of its log, as text
//   bridge.mjs result [turn]    the full record of a turn (the last one that ended, when
//                               none is named): its answer, what it did and what it cost
//   bridge.mjs wait <turn> --from <offset>
//                               waits until the turn's log has something new, or the turn
//                               is over, and prints { status, nextOffset, text } as JSON.
//                               The hooks module shows each such stretch as a row.
//
// `run` keeps a record and a log of its turn on disk as it goes (lib/state.mjs), which is
// what `status` and `result` read: while the turn runs, after it, and when it was stopped
// before it could hand back a report.
//
// `run` and the module talk through a control directory the bridge makes for the turn and
// names in its first event. Since stdin is closed, that is the way back: the module writes
// `answer-<id>.json` there to answer a request for approval, and `cancel` to stop the
// turn. The bridge looks for them a few times a second.
//
// The directory is in the system temp directory, which a backend's sandbox can write to,
// so a delegate could write an answer of its own there. Every file the bridge reads must
// carry the turn's token, which goes out only on stdout, to the module; a file without
// it, or one not yet complete, is passed over.
//
// Events, one JSON object per line:
//   { type: "ready", controlDir, token, jobId }   jobId names the turn's record
//   { type: "event", event }                 a BackendEvent (see lib/backends/index.mjs)
//   { type: "approval", id, request }        an ApprovalRequest; answer with answer-<id>.json
//                                            holding { "token", "choice": "<id of one of request.choices>" },
//                                            or { "token", "text": "..." }: the user's own words,
//                                            which decline the request and are passed on
//   { type: "result", result, report }       the RunResult, and the report for Claude
// and `cancel` holds { "token" }.
//
// A request with `leaseSec` is watched: the module writes `alive` into the control directory
// as it follows the turn, and a turn nobody has followed for that long is stopped. That is
// how a turn ends when its subagent is gone at a moment in which no hook was running.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BACKENDS, getBackend } from "./lib/backends/index.mjs";
import { agentLabel, optionLabel, renderJobDetail, renderModels, renderReport, renderResult, renderSetup, renderStatusList } from "./lib/report.mjs";
import { appendLog, findJob, finishJob, isActive, listJobs, newJobId, pruneJobs, readLogFrom, readLogTail, updateJob, writeJob } from "./lib/state.mjs";
import { oneLine } from "./lib/text.mjs";

const POLL_MS = 150;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

/**
 * Where DELEGATE_TRACE=1 has a turn write every JSON-RPC message, or null: a new directory
 * of its own (mkdtemp, mode 0700), so that nobody else can have made it or put a link there.
 */
function traceFileFor(backendName) {
  if (process.env.DELEGATE_TRACE !== "1") return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-trace-"));
  return path.join(dir, `${backendName}.trace.jsonl`);
}

/**
 * @typedef {object} TurnRequest
 * @property {string} backend          "codex" | "agy"
 * @property {string} cwd
 * @property {string} prompt
 * @property {string} permission       one of the backend's own options
 * @property {"enabled" | "disabled" | null} [sandbox]   "disabled" to run without the option's sandbox, "enabled" to add one
 * @property {"ask" | "decline"} approvals   whether requests beyond the option are put to the user
 * @property {string | null} [mode]    the conversation's permission mode, for the report
 * @property {string | null} [model]
 * @property {string | null} [effort]
 * @property {string | null} [resumeSessionId]
 * @property {number} [leaseSec]       stop the turn when `alive` in the control directory is older than this
 */

async function cmdRun() {
  /** @type {TurnRequest} */
  const request = JSON.parse(await readStdin());
  const backend = getBackend(request.backend);
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-ctl-"));
  const token = randomBytes(24).toString("hex");
  const controller = new AbortController();
  const pending = new Map();
  let nextId = 1;

  const settleAll = () => {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };
  controller.signal.addEventListener("abort", settleAll, { once: true });

  /** A control file's content if it is complete and carries the turn's token, else null. */
  const readSigned = (name) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(controlDir, name), "utf8"));
      return parsed && typeof parsed === "object" && parsed.token === token ? parsed : null;
    } catch {
      return null;
    }
  };

  // The lease. A machine that slept is not a turn nobody followed: when this process was
  // itself held up, the count starts again.
  const leaseMs = Math.max(0, Number(request.leaseSec) || 0) * 1000;
  let leaseFrom = Date.now();
  let lastTick = Date.now();
  let leaseRanOut = false;
  const followedAt = () => {
    try {
      return Math.max(leaseFrom, fs.statSync(path.join(controlDir, "alive")).mtimeMs);
    } catch {
      return leaseFrom;
    }
  };

  const poll = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 10_000) leaseFrom = now;
    lastTick = now;
    if (leaseMs > 0 && !controller.signal.aborted && now - followedAt() > leaseMs) {
      leaseRanOut = true;
      controller.abort();
    }
    if (!controller.signal.aborted && readSigned("cancel")) controller.abort();
    for (const [id, resolve] of pending) {
      const signed = readSigned(`answer-${id}.json`);
      if (!signed) continue;
      let answer = null;
      if (typeof signed.choice === "string") answer = signed.choice;
      else if (typeof signed.text === "string" && signed.text.trim()) answer = { text: signed.text };
      pending.delete(id);
      resolve(answer);
    }
  }, POLL_MS);

  // Claude Code stops the bridge when the subagent is stopped. The turn is interrupted
  // then, as it would be through the control directory.
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // A session takes one turn at a time. Another turn of this workspace that is still running
  // on the session this one continues is found in the records, before this one's own is written.
  let busy = null;
  if (request.resumeSessionId) {
    try {
      busy = listJobs(request.cwd).find((job) => isActive(job) && job.backend === backend.name && job.sessionId === request.resumeSessionId) ?? null;
    } catch {
      busy = null;
    }
  }

  // The turn's record. Keeping it never fails the turn: where it cannot be written, the
  // turn runs without one.
  let jobId = null;
  const record = (work) => {
    if (jobId === null) return;
    try {
      work(jobId);
    } catch {
      // Best effort.
    }
  };
  try {
    const job = writeJob(request.cwd, {
      id: newJobId(),
      backend: backend.name,
      agent: agentLabel(backend, request.model ?? null, request.effort ?? null),
      option: optionLabel(request.permission, request.sandbox ?? null),
      mode: request.mode ?? null,
      cwd: request.cwd,
      task: request.prompt,
      status: "running",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      sessionId: request.resumeSessionId ?? null
    });
    jobId = job.id;
    pruneJobs(request.cwd);
  } catch {
    jobId = null;
  }
  const log = (text) => record((id) => appendLog(request.cwd, id, text));
  log(`started ${backend.name} with ${optionLabel(request.permission, request.sandbox ?? null)}${request.resumeSessionId ? `, continuing session ${request.resumeSessionId}` : ""}`);

  emit({ type: "ready", controlDir, token, jobId });

  const startedAt = Date.now();
  let shown = { model: request.model ?? null, effort: null };
  // The session the backend opened or resumed, for a turn that fails after that.
  let openedSession = null;
  const onEvent = (event) => {
    if (event.type === "session") {
      openedSession = event.sessionId;
      shown = { model: event.model ?? shown.model, effort: event.effort ?? null };
      record((id) => updateJob(request.cwd, id, { sessionId: event.sessionId, agent: agentLabel(backend, shown.model, shown.effort) }));
      log(`session ${event.sessionId}${event.model ? ` · model ${event.model}` : ""}${event.effort ? ` · effort ${event.effort}` : ""}`);
    } else if (event.type === "action") {
      const { kind, title, status, exitCode } = event.action;
      const head = `${kind}${status ? ` ${status}` : ""}${exitCode === undefined || exitCode === null ? "" : ` (exit ${exitCode})`}: ${oneLine(title, 300)}`;
      log(event.output ? `${head}\n${event.output}` : head);
    } else if (event.type === "note") {
      log(`note: ${event.text}`);
    } else {
      log(event.text);
    }
    emit({ type: "event", event });
  };
  const onApproval =
    request.approvals === "ask"
      ? (ask) =>
          new Promise((resolve) => {
            if (controller.signal.aborted) return resolve(null);
            const id = nextId++;
            pending.set(id, (answer) => {
              log(`the user answered: ${answer === null ? "(no answer)" : typeof answer === "string" ? answer : "in their own words"}`);
              resolve(answer);
            });
            log(`asked the user: ${ask.kind} ${oneLine(ask.title, 300)}`);
            emit({ type: "approval", id, request: ask });
          })
      : undefined;

  const traceFile = traceFileFor(backend.name);
  let result;
  try {
    if (busy) {
      throw new Error(`session ${request.resumeSessionId} is in use: turn ${busy.id} is still running on it. Wait for that turn to end, or stop it, and send this again.`);
    }
    result = await backend.run({
      cwd: request.cwd,
      prompt: request.prompt,
      permission: request.permission,
      sandbox: request.sandbox || undefined,
      model: request.model || undefined,
      effort: request.effort || undefined,
      resumeSessionId: request.resumeSessionId || undefined,
      signal: controller.signal,
      traceFile,
      onEvent,
      onApproval
    });
  } catch (error) {
    result = {
      status: controller.signal.aborted ? "cancelled" : "failed",
      sessionId: openedSession ?? request.resumeSessionId ?? null,
      model: shown.model,
      text: "",
      actions: [],
      usage: null,
      error: error?.message ?? String(error)
    };
  } finally {
    clearInterval(poll);
    settleAll();
    fs.rmSync(controlDir, { recursive: true, force: true });
  }

  if (leaseRanOut) result.notes = [...(result.notes ?? []), `nothing followed this turn for ${Math.round(leaseMs / 1000)}s (its subagent was gone), so it was stopped`];
  if (traceFile) result.notes = [...(result.notes ?? []), `the JSON-RPC trace of this turn is in ${traceFile}`];
  const report = renderReport({
    backend,
    permission: result.permission ?? request.permission,
    sandbox: request.sandbox ?? null,
    approvals: request.approvals,
    mode: request.mode ?? null,
    model: result.model ?? shown.model,
    effort: shown.effort,
    durationMs: Date.now() - startedAt,
    jobId,
    result
  });
  record((id) => {
    updateJob(request.cwd, id, {
      agent: agentLabel(backend, result.model ?? shown.model, shown.effort),
      option: optionLabel(result.permission ?? request.permission, request.sandbox ?? null),
      sessionId: result.sessionId ?? null
    });
    finishJob(request.cwd, id, result.status, { text: result.text, actions: result.actions, usage: result.usage, error: result.error, notes: result.notes });
  });
  log(`finished: ${result.status}${result.error ? ` · ${String(result.error).split("\n")[0]}` : ""}`);
  emit({ type: "result", result, report });
  return 0;
}

async function cmdModels([wanted]) {
  const cwd = process.cwd();
  const backends = wanted ? [getBackend(wanted)] : Object.values(BACKENDS);
  const entries = await Promise.all(
    backends.map(async (backend) => {
      try {
        return { backend: backend.name, agentName: backend.agentName, list: await backend.listModels({ cwd }) };
      } catch (error) {
        return { backend: backend.name, agentName: backend.agentName, error: error?.message ?? String(error) };
      }
    })
  );
  console.log(renderModels(entries));
  return entries.some((entry) => entry.list) ? 0 : 1;
}

async function cmdSetup() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const report = {
    node: { version: process.versions.node, ok: major > 18 || (major === 18 && minor >= 18) },
    backends: await Promise.all(
      Object.values(BACKENDS).map(async (backend) => ({ name: backend.name, label: backend.label, ...(await backend.check()) }))
    )
  };
  console.log(renderSetup(report));
  return 0;
}

/** The turn `status` or `result` was asked about: by its id, or the newest that fits. */
function pickJob(cwd, id, fits) {
  if (id) {
    const found = findJob(cwd, id);
    if (!found) throw new Error(`No turn "${id}" is on record. \`status\` lists the turns of this workspace.`);
    return found;
  }
  const job = listJobs(cwd).find(fits);
  return job ? { job, home: cwd } : null;
}

function cmdStatus([id]) {
  const cwd = process.cwd();
  if (!id) {
    console.log(renderStatusList(listJobs(cwd)));
    return 0;
  }
  const { job, home } = pickJob(cwd, id);
  console.log(renderJobDetail(job, readLogTail(home, job.id)));
  return 0;
}

function cmdResult([id]) {
  const picked = pickJob(process.cwd(), id, (job) => !isActive(job));
  console.log(picked ? renderResult(picked.job) : "No delegate turn has ended in this workspace yet.");
  return 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const envMs = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== undefined && process.env[name] !== "" ? Number(process.env[name]) : fallback);

/**
 * How long `wait` goes on gathering once something new is in the log, by the turn's age:
 * a young turn is shown step by step, a long one about once a minute.
 */
function settleMsFor(job) {
  const ageMs = Date.now() - Date.parse(job.createdAt);
  return envMs("DELEGATE_ROW_SETTLE_MS", ageMs < 60_000 ? 4_000 : ageMs < 300_000 ? 15_000 : 45_000);
}

async function cmdWait([id, ...rest]) {
  const fromAt = rest.indexOf("--from");
  const from = Math.max(0, Number(fromAt === -1 ? 0 : rest[fromAt + 1]) || 0);
  const cwd = process.cwd();
  const maxMs = envMs("DELEGATE_ROW_MAX_MS", 90_000);
  const startedAt = Date.now();
  let newsAt = null;
  let found = id ? findJob(cwd, id) : null;
  while (found && isActive(found.job)) {
    const now = Date.now();
    if (newsAt === null && readLogFrom(found.home, id, from).nextOffset > from) newsAt = now;
    if (newsAt !== null && now - newsAt >= settleMsFor(found.job)) break;
    if (now - startedAt >= maxMs) break;
    await sleep(200);
    found = findJob(cwd, id);
  }
  if (!found) {
    console.log(JSON.stringify({ status: "unknown", nextOffset: from, text: "" }));
    return 0;
  }
  const { text, nextOffset } = readLogFrom(found.home, id, from);
  console.log(JSON.stringify({ status: found.job.status, nextOffset, text }));
  return 0;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "run":
      return cmdRun();
    case "models":
      return cmdModels(argv);
    case "setup":
      return cmdSetup();
    case "status":
      return cmdStatus(argv);
    case "result":
      return cmdResult(argv);
    case "wait":
      return cmdWait(argv);
    default:
      throw new Error(`Unknown command "${command ?? ""}". Use run, models, setup, status, result or wait.`);
  }
}

/**
 * Exit once everything printed so far has left the process. Output to a pipe is written
 * asynchronously, so calling process.exit() directly cuts off whatever is still queued.
 */
function exitWhenFlushed(code) {
  const exit = () => process.exit(code);
  process.stdout.on("error", exit);
  process.stderr.on("error", exit);
  process.stdout.write("", () => process.stderr.write("", exit));
}

main().then(
  (code) => exitWhenFlushed(code ?? 0),
  (error) => {
    const message = error?.message ?? String(error);
    if (process.argv[2] === "run") emit({ type: "error", message });
    console.error(`[delegate] ${message}`);
    exitWhenFlushed(2);
  }
);
