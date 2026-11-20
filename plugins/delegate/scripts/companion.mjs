#!/usr/bin/env node
// Entry point for the delegate plugin. Every command, agent and skill calls this one
// script. USAGE, near the end of the file, lists the commands and their options.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs, takeLeadingOptions } from "./lib/args.mjs";
import { BACKENDS, getBackend } from "./lib/backends/index.mjs";
import { DEFAULT_MAX_WAIT_SEC, settleWindowMs } from "./lib/pacing.mjs";
import { statusLine } from "./lib/progress.mjs";
import { renderAnswer, renderJobDetail, renderModels, renderResult, renderRunning, renderSetup, renderStatusList } from "./lib/render.mjs";
import {
  appendLog,
  finishJob,
  getJob,
  isActive,
  isAlive,
  lastHeartbeatMs,
  linkedWorktree,
  listJobs,
  locateJob,
  logFile,
  logSize,
  newJobId,
  pruneJobs,
  readCursor,
  readJob,
  readLogFrom,
  readLogTail,
  touchHeartbeat,
  updateJob,
  writeCursor,
  writeJob
} from "./lib/state.mjs";
import { oneLine } from "./lib/text.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CANCEL_WAIT_MS = 15_000;
const WORKER_REGISTER_WAIT_MS = 5_000;
// A job stops itself when nothing has waited on it for this long, so that a delegate
// does not keep working after the subagent watching it was interrupted.
const DEFAULT_LEASE_SEC = 120;
const LEASE_TICK_MS = 2000;
// The options a request may carry at its top, written by whoever composed it.
const REQUEST_OPTIONS = ["permission", "sandbox", "model", "effort", "brief-file"];

function readTextFile(file, what) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Error(`Could not read ${what} ${file}: ${error.code ?? error.message}.`);
  }
}

/**
 * Save a job's answer where its caller left the message, and return the file's path. A
 * caller that hands the message over in a file gets the answer back the same way, so
 * that neither has to pass through a model that would retype it: only the path does.
 * Returns null when there is no such place or no answer, and the answer is then printed.
 */
function saveAnswer(job, text) {
  if (!job.exchangeDir || !String(text ?? "").trim()) return null;
  const file = path.join(job.exchangeDir, `${job.id}.md`);
  try {
    fs.writeFileSync(file, `${text.trimEnd()}\n`, "utf8");
    return file;
  } catch {
    return null;
  }
}

function leaseSeconds() {
  const raw = process.env.DELEGATE_LEASE_SEC;
  if (raw === undefined || raw === "") return DEFAULT_LEASE_SEC;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LEASE_SEC; // 0 turns the lease off.
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    // Give up if nothing is piped in, so an open-but-silent stdin cannot hang the command.
    const idle = setTimeout(() => {
      process.stdin.pause();
      resolve(data);
    }, 3000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      clearTimeout(idle);
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(idle);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(idle);
      resolve(data);
    });
  });
}

function parseTimeoutSec(value) {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout-sec must be a positive number.");
  return seconds;
}

/**
 * Work out which backend session `--resume <reference>` means. The reference can be
 * a job id (or unique prefix), a session id that a job here ran on, or, together with
 * --backend, a session id this workspace has never seen.
 */
function resolveResume(jobs, reference, backendName) {
  const job = matchJob(jobs, reference) ?? jobs.find((candidate) => candidate.sessionId === reference);
  if (job) {
    if (!job.sessionId) throw new Error(`Job ${job.id} never opened a session, so there is nothing to resume.`);
    return { sessionId: job.sessionId, backend: job.backend, job };
  }
  if (backendName) return { sessionId: reference, backend: backendName, job: null };
  throw new Error(
    `"${reference}" is not a job or session known in this workspace. Add --backend to resume a session id from elsewhere.`
  );
}

/** The job with that id, or with the one id that starts with it. Null when there is none. */
function matchJob(jobs, reference) {
  const exact = jobs.find((job) => job.id === reference);
  if (exact) return exact;
  const matches = jobs.filter((job) => job.id.startsWith(reference));
  if (matches.length > 1) throw new Error(`"${reference}" matches more than one job. Use the full job id.`);
  return matches[0] ?? null;
}

/**
 * The job a reference means, and the directory to reach its records through. A job of
 * this workspace is found by id or by a unique start of one. A job started somewhere
 * else is found by its full id, so that it can be waited on from anywhere.
 */
function findJob(cwd, reference) {
  const here = getJob(cwd, reference) ?? matchJob(listJobs(cwd), reference);
  if (here) return { job: here, home: cwd };
  const elsewhere = locateJob(reference);
  if (elsewhere) return elsewhere;
  throw new Error(`No job "${reference}". Run \`status --all\` to list the jobs of this workspace.`);
}

async function runJob(cwd, id) {
  const job = readJob(cwd, id);
  if (!job) throw new Error(`Job ${id} not found.`);
  if (job.status !== "queued") return job; // Cancelled before the worker got going, or already run.
  const backend = getBackend(job.backend);
  const controller = new AbortController();
  // Set when the job stops itself (time limit, or nobody following): what to report.
  let stopError = null;

  const onSignal = () => {
    appendLog(cwd, id, "cancel requested");
    controller.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const timer = job.timeoutSec
    ? setTimeout(() => {
        stopError ??= `Timed out after ${job.timeoutSec}s and was interrupted.`;
        appendLog(cwd, id, `timed out after ${job.timeoutSec}s`);
        controller.abort();
      }, job.timeoutSec * 1000)
    : null;

  const leaseSec = leaseSeconds();
  // The lease counts from the latest of: the job starting, the last `wait`, and this
  // process waking up after having been suspended.
  let leaseFloorMs = Date.now();
  let lastTickMs = leaseFloorMs;
  const leaseTimer =
    leaseSec > 0
      ? setInterval(() => {
          const now = Date.now();
          // A tick that arrives far too late means the machine was asleep (or the process
          // was stopped). Whoever waits on it was frozen too, so the silence proves nothing:
          // give it a full window to come back.
          if (now - lastTickMs > LEASE_TICK_MS * 5) leaseFloorMs = now;
          lastTickMs = now;
          const lastSeen = Math.max(leaseFloorMs, lastHeartbeatMs(cwd, id) ?? 0);
          if (controller.signal.aborted || now - lastSeen <= leaseSec * 1000) return;
          stopError ??= `Stopped because nothing waited on the job for ${leaseSec}s. The subagent watching it was probably interrupted.`;
          appendLog(cwd, id, `nothing has waited on this job for ${leaseSec}s; stopping it`);
          controller.abort();
        }, LEASE_TICK_MS)
      : null;
  leaseTimer?.unref();

  updateJob(cwd, id, { status: "running", pid: process.pid, startedAt: nowIso() });
  appendLog(
    cwd,
    id,
    `started ${job.backend} (permission ${job.permission}${job.sandbox ? `, sandbox ${job.sandbox}` : ""})${job.resumeSessionId ? ", resuming session" : ""}`
  );

  let result;
  try {
    result = await backend.run({
      cwd: job.cwd,
      prompt: job.prompt,
      permission: job.permission,
      sandbox: job.sandbox,
      model: job.model,
      effort: job.effort,
      resumeSessionId: job.resumeSessionId,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "session") {
          updateJob(cwd, id, { sessionId: event.sessionId, model: event.model ?? job.model ?? null, shownEffort: event.effort ?? null });
          appendLog(cwd, id, `session ${event.sessionId}${event.model ? ` · model ${event.model}` : ""}${event.effort ? ` · effort ${event.effort}` : ""}`);
        } else if (event.type === "action") {
          const { kind, title, status, exitCode } = event.action;
          const exit = exitCode !== undefined && exitCode !== null ? ` (exit ${exitCode})` : "";
          const head = `${kind} ${status ?? "done"}${exit}: ${oneLine(title)}`;
          appendLog(cwd, id, event.output ? `${head}\n${event.output}` : head);
        } else if (event.type === "progress" || event.type === "note") {
          appendLog(cwd, id, event.text);
        }
      }
    });
  } catch (error) {
    result = {
      status: controller.signal.aborted ? "cancelled" : "failed",
      sessionId: null,
      model: null,
      text: "",
      actions: [],
      usage: null,
      error: error?.message ?? String(error)
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (leaseTimer) clearInterval(leaseTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }

  if (stopError) {
    result.status = "cancelled";
    result.error = stopError;
  }

  const latest = readJob(cwd, id) ?? job;
  appendLog(cwd, id, `finished: ${result.status}${result.error ? ` · ${result.error.split("\n")[0]}` : ""}`);
  return finishJob(
    cwd,
    {
      ...latest,
      sessionId: result.sessionId ?? latest.sessionId ?? null,
      model: result.model ?? latest.model ?? null,
      answerFile: saveAnswer(latest, result.text)
    },
    result.status,
    { text: result.text, actions: result.actions, usage: result.usage, error: result.error }
  );
}

/**
 * Start a turn and wait for its first news.
 *
 * The request is the task, with its options written at the top by whoever composed it
 * (see takeLeadingOptions). Those win over the same options on the command line, which
 * is for callers that have no request to write them in.
 *
 * The request reaches this command in one of four ways. The forwarding subagent uses
 * --message-file: text of any kind arrives whole that way, where on a command line or in
 * a heredoc it would have to get past the shell and past Claude Code's checks on shell
 * commands. That file is the subagent's own scratch copy, so it is removed once read, and
 * the answer is saved in the same directory (see saveAnswer).
 */
async function cmdRun(argv) {
  const { options: given, positionals } = parseArgs(argv, {
    values: ["backend", ...REQUEST_OPTIONS, "resume", "cwd", "prompt-file", "message-file", "timeout-sec", "max-wait-sec", "settle-sec"]
  });
  const cwd = path.resolve(given.cwd ?? process.cwd());

  let text = positionals.join(" ").trim();
  let exchangeDir = null;
  if (given["message-file"]) {
    const file = path.resolve(cwd, given["message-file"]);
    text = readTextFile(file, "the message file");
    exchangeDir = path.dirname(file);
    fs.rmSync(file, { force: true });
  } else if (given["prompt-file"]) {
    text = readTextFile(path.resolve(cwd, given["prompt-file"]), "the prompt file");
  }
  if (!text) text = (await readStdin()).trim();
  const { options: written, body } = takeLeadingOptions(text, REQUEST_OPTIONS);
  const options = { ...given, ...written };
  // A long brief, or one full of code, can be kept in a file and named at the top of the
  // request. Whatever else the request says follows it.
  const brief = options["brief-file"] ? readTextFile(path.resolve(cwd, options["brief-file"]), "the brief file") : "";
  const prompt = [brief, body].filter(Boolean).join("\n\n");
  if (!prompt) throw new Error("No task text. Pass it as an argument, in a file, or on stdin.");

  const jobs = listJobs(cwd);
  const resume = options.resume ? resolveResume(jobs, options.resume, options.backend) : null;
  if (resume && options.backend && options.backend !== resume.backend) {
    throw new Error(`That session belongs to ${resume.backend}; it cannot be resumed on ${options.backend}.`);
  }
  const backendName = options.backend ?? resume?.backend;
  if (!backendName) throw new Error(`Missing --backend. Choose one of: ${Object.keys(BACKENDS).join(", ")}.`);
  const backend = getBackend(backendName);

  // Each turn says what it may do. A turn that does not say keeps what the conversation's
  // last turn had, so a conversation can be continued with more, with less, or as it was.
  const earlier = resume?.job ?? {};
  const { permission, sandbox } = backend.settingsFor({
    permission: options.permission ?? earlier.permission,
    sandbox: options.sandbox ?? (options.permission === undefined ? earlier.sandbox : undefined)
  });

  if (resume) {
    // One turn at a time per session: two writers on one session lose or reject a turn.
    const busy = jobs.find(
      (job) => isActive(job) && (job.sessionId === resume.sessionId || job.resumeSessionId === resume.sessionId)
    );
    if (busy) {
      throw new Error(`Session ${resume.sessionId} is busy: job ${busy.id} is still running on it. Wait for it or cancel it first.`);
    }
  }

  const timeoutSec = parseTimeoutSec(options["timeout-sec"]);
  const waits = waitOptions(options);

  const job = writeJob(cwd, {
    id: newJobId(),
    backend: backendName,
    // How the agent is named wherever the job is shown. The model joins it once known.
    agentName: backend.agentName,
    cwd,
    // Set when the task was started inside a linked git worktree, as happens when Claude
    // Code runs the subagent with worktree isolation. The delegate's edits are there.
    worktree: linkedWorktree(cwd),
    prompt,
    // Where the message came from as a file, and so where the answer is to be saved.
    exchangeDir,
    permission,
    sandbox,
    // A resumed session keeps the model and effort it ran with unless told otherwise
    // (agy falls back to its default model on load).
    model: options.model ?? earlier.model ?? null,
    effort: options.effort ?? earlier.effort ?? null,
    timeoutSec,
    resumeSessionId: resume?.sessionId ?? null,
    status: "queued",
    pid: null,
    sessionId: null,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    result: null
  });
  pruneJobs(cwd, jobs);

  // Every task runs as a detached worker, so that it outlives this command: a call from
  // Claude Code may last a few minutes at most, and a task may take far longer.
  const out = fs.openSync(logFile(cwd, job.id), "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "worker", "--cwd", cwd, "--job-id", job.id], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  fs.closeSync(out);
  return reportNews(cwd, job, waits);
}

async function cmdWorker(argv) {
  const { options } = parseArgs(argv, { values: ["cwd", "job-id"] });
  if (!options.cwd || !options["job-id"]) throw new Error("worker needs --cwd and --job-id.");
  const finished = await runJob(options.cwd, options["job-id"]);
  return finished.status === "completed" ? 0 : 1;
}

function cmdStatus(argv) {
  const { options, positionals } = parseArgs(argv, { booleans: ["all", "json"], values: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (positionals[0]) {
    const { job, home } = findJob(cwd, positionals[0]);
    console.log(options.json ? JSON.stringify(job, null, 2) : renderJobDetail(job, readLogTail(home, job.id)));
    return 0;
  }
  const jobs = listJobs(cwd);
  const shown = options.all ? jobs : jobs.slice(0, 10);
  console.log(options.json ? JSON.stringify(shown, null, 2) : renderStatusList(shown));
  return 0;
}

function cmdResult(argv) {
  const { options, positionals } = parseArgs(argv, { booleans: ["json"], values: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const { job, home } = positionals[0]
    ? findJob(cwd, positionals[0])
    : { job: listJobs(cwd).find((candidate) => !isActive(candidate)), home: cwd };
  if (!job) throw new Error("No finished job in this workspace yet.");
  if (options.json) console.log(JSON.stringify(job, null, 2));
  else console.log(isActive(job) ? renderJobDetail(job, readLogTail(home, job.id)) : renderResult(job));
  return 0;
}

/** --max-wait-sec and --settle-sec, as `run` and `wait` both take them. */
function waitOptions(options) {
  const nonNegative = (name, fallback) => {
    if (options[name] === undefined) return fallback;
    const value = Number(options[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be zero or more.`);
    return value;
  };
  return { maxWaitMs: nonNegative("max-wait-sec", DEFAULT_MAX_WAIT_SEC) * 1000, settleSec: nonNegative("settle-sec", null) };
}

/**
 * Wait until a job has news, then print it. This is all a caller ever reads of a job.
 *
 * If the job is over, the output is its answer and nothing else (renderAnswer): the
 * caller hands it on word for word. If not, the output is three fixed lines
 * (renderRunning): that it is still running, one line on what it did last, and the
 * command to run next. The caller decides nothing and keeps nothing between calls: how
 * far it has been told is kept here, in the job's cursor.
 *
 * It returns when there is something to tell, not on a timer: once the job has logged
 * new activity it keeps collecting for a short settle window and then returns. With no
 * activity it returns after --max-wait-sec, and it always returns when the job ends. So
 * a quiet delegate costs the caller almost no calls, and a busy one costs at most one
 * call per settle window. Every call also marks the job as watched (see the lease in
 * runJob).
 */
async function reportNews(cwd, job, { maxWaitMs, settleSec }) {
  const offset = readCursor(cwd, job.id);
  const settleMs = () =>
    settleSec !== null ? settleSec * 1000 : settleWindowMs(Date.now() - Date.parse(job.startedAt ?? job.createdAt));

  const startedAt = Date.now();
  let lastBeat = 0;
  let firstNewAt = null;
  // How far the log has been looked at. It moves past stretches that hold nothing worth
  // telling (the job starting, the model thinking), so that those do not cost the caller
  // a call of their own.
  let seen = offset;
  for (;;) {
    const now = Date.now();
    if (now - lastBeat >= 3000) {
      touchHeartbeat(cwd, job.id);
      lastBeat = now;
    }
    if (!isActive(job)) break;
    if (firstNewAt === null && logSize(cwd, job.id) > seen) firstNewAt = now;
    if (firstNewAt !== null && now - firstNewAt >= settleMs()) {
      const batch = readLogFrom(cwd, job.id, offset);
      if (statusLine(batch.text, { cwd: job.cwd })) break;
      seen = batch.nextOffset;
      firstNewAt = null;
    }
    if (now - startedAt >= maxWaitMs) break;
    await sleep(300);
    job = getJob(cwd, job.id) ?? job;
  }
  touchHeartbeat(cwd, job.id);

  if (!isActive(job)) {
    console.log(renderAnswer(job));
    return 0;
  }
  const { text, nextOffset } = readLogFrom(cwd, job.id, offset);
  writeCursor(cwd, job.id, nextOffset);
  console.log(renderRunning(job, statusLine(text, { cwd: job.cwd }), `node "${SCRIPT_PATH}" wait ${job.id}`));
  return 0;
}

async function cmdWait(argv) {
  const { options, positionals } = parseArgs(argv, { values: ["cwd", "max-wait-sec", "settle-sec"] });
  if (!positionals[0]) throw new Error("wait needs a job id.");
  const { job, home } = findJob(path.resolve(options.cwd ?? process.cwd()), positionals[0]);
  return reportNews(home, job, waitOptions(options));
}

async function cmdCancel(argv) {
  const { options, positionals } = parseArgs(argv, { values: ["cwd"] });
  const found = positionals[0] ? findJob(path.resolve(options.cwd ?? process.cwd()), positionals[0]) : null;
  const cwd = found?.home ?? path.resolve(options.cwd ?? process.cwd());
  let job = found?.job ?? listJobs(cwd).find(isActive);
  if (!job) {
    console.log("No running job to cancel.");
    return 0;
  }

  // A job that was only just started has no worker pid on record yet. Give the worker
  // a moment to register, so that it can be signalled instead of merely marked.
  const registerDeadline = Date.now() + WORKER_REGISTER_WAIT_MS;
  while (isActive(job) && !job.pid && Date.now() < registerDeadline) {
    await sleep(100);
    job = getJob(cwd, job.id) ?? job;
  }
  if (!isActive(job)) {
    console.log(`Job ${job.id} already finished (${job.status}).`);
    return 0;
  }

  if (job.pid && isAlive(job.pid)) {
    // The owning process interrupts the backend turn and records the outcome itself.
    process.kill(job.pid, "SIGTERM");
    const deadline = Date.now() + CANCEL_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(250);
      const current = getJob(cwd, job.id);
      if (!isActive(current)) {
        console.log(`Cancelled ${job.id} (${current.status}).`);
        return 0;
      }
    }
    try {
      process.kill(job.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  finishJob(cwd, readJob(cwd, job.id) ?? job, "cancelled", {
    ...(job.result ?? {}),
    error: "Cancelled; the job's process had to be force-stopped."
  });
  console.log(`Cancelled ${job.id} (force-stopped).`);
  return 0;
}

/** List the models each backend offers. One backend failing does not hide the others. */
async function cmdModels(argv) {
  const { options, positionals } = parseArgs(argv, { booleans: ["json"], values: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const wanted = positionals[0];
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
  console.log(options.json ? JSON.stringify(entries, null, 2) : renderModels(entries));
  return entries.some((entry) => entry.list) ? 0 : 1;
}

function cmdSetup(argv) {
  const { options } = parseArgs(argv, { booleans: ["json"] });
  const [major, minor] = process.versions.node.split(".").map(Number);
  const report = {
    node: { version: process.versions.node, ok: major > 18 || (major === 18 && minor >= 18) },
    backends: Object.values(BACKENDS).map((backend) => ({ name: backend.name, label: backend.label, ...backend.check() }))
  };
  console.log(options.json ? JSON.stringify(report, null, 2) : renderSetup(report));
  return 0;
}

const USAGE = `Usage:
  companion.mjs run    --backend <${Object.keys(BACKENDS).join("|")}> [--resume <session-or-job>]
                       [--permission <option>] [--sandbox <enabled|disabled>] [--model <id>] [--effort <level>]
                       [--timeout-sec <n>] [--cwd <dir>]
                       [task text | --prompt-file <path> | --message-file <path> | stdin]
  companion.mjs wait   <job> [--max-wait-sec <n>] [--settle-sec <n>]
  companion.mjs status [job] [--all] [--json]
  companion.mjs result [job] [--json]
  companion.mjs cancel [job]
  companion.mjs models [backend] [--json]
  companion.mjs setup  [--json]

run starts a job and waits for its first news. If the job is over, run prints its
answer. If not, it prints "[delegate] still running", one line on what the delegate did
last, and the wait command to run next. wait does the same for a job that is running.
A job that nothing waits on for ${DEFAULT_LEASE_SEC}s stops itself.

--permission, --sandbox, --model and --effort may also be written at the top of the
task text, before the task itself. What is written there wins. --brief-file <path>
there adds the content of a file to the task.

--message-file is how a caller passes the task without retyping it into a command, and
gets the answer back without retyping it either: the file is read and removed, and the
answer is saved beside it as <job>.md, with only its path printed.

--permission takes one of the backend's own options:
${Object.values(BACKENDS)
  .map((backend) => `  ${backend.name}: ${Object.keys(backend.permissions).join(", ")}   (default ${backend.defaultPermission})`)
  .join("\n")}
Nobody can approve a request while a delegate runs: what it asks about is declined and
listed in the result. --resume continues a conversation, and each turn may name a
different --permission. Left out, a turn keeps what the conversation's last turn had.`;

async function main() {
  const [command, ...rawArgv] = process.argv.slice(2);
  // A slash command passes everything the user typed as one quoted string
  // ("task-abc --all"). Only that single-argument form is split. Arguments that arrive
  // already separated are left alone, so that a path with a space in it stays whole.
  const argv =
    command !== "run" && rawArgv.length === 1 ? rawArgv[0].trim().split(/\s+/).filter(Boolean) : rawArgv;
  switch (command) {
    case "run":
      return cmdRun(argv);
    case "worker":
      return cmdWorker(argv);
    case "status":
      return cmdStatus(argv);
    case "result":
      return cmdResult(argv);
    case "wait":
      return cmdWait(argv);
    case "cancel":
      return cmdCancel(argv);
    case "models":
      return cmdModels(argv);
    case "setup":
      return cmdSetup(argv);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      throw new Error(`Unknown command "${command}".\n${USAGE}`);
  }
}

/**
 * Exit once everything printed so far has left the process. Output to a pipe is written
 * asynchronously, so calling process.exit() directly cuts off whatever is still queued:
 * anything past the pipe's buffer (64 KB) would be lost.
 */
function exitWhenFlushed(code) {
  const exit = () => process.exit(code);
  // If the reader has gone away there is nothing left to wait for.
  process.stdout.on("error", exit);
  process.stderr.on("error", exit);
  process.stdout.write("", () => process.stderr.write("", exit));
}

main().then(
  (code) => exitWhenFlushed(code ?? 0),
  (error) => {
    console.error(`[delegate] ${error?.message ?? error}`);
    exitWhenFlushed(2);
  }
);
