#!/usr/bin/env node
// Entry point for the delegate plugin. Every command, agent and skill calls this one
// script. USAGE, near the end of the file, lists the commands and their options.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CONVERSATION_MODE_FLAG, TOKEN_FLAG, parseArgs } from "./lib/args.mjs";
import { BACKENDS, getBackend } from "./lib/backends/index.mjs";
import { DEFAULT_MAX_WAIT_SEC, settleWindowMs } from "./lib/pacing.mjs";
import { FALLBACK_MODE, MODES, resolvePermissionMode } from "./lib/permission.mjs";
import { compactLog } from "./lib/progress.mjs";
import {
  renderJobDetail,
  agentOf,
  renderAnswer,
  renderModels,
  renderPending,
  renderResult,
  renderSetup,
  renderStarted,
  renderStatusList
} from "./lib/render.mjs";
import {
  appendLog,
  createSecret,
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
  readJob,
  readLogFrom,
  readLogTail,
  readSecret,
  takeAnswer,
  touchHeartbeat,
  updateJob,
  writeAnswer,
  writeJob
} from "./lib/state.mjs";
import { oneLine } from "./lib/text.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CANCEL_WAIT_MS = 15_000;
const WORKER_REGISTER_WAIT_MS = 5_000;
// A job stops itself when nothing has followed it for this long, so that a delegate
// does not keep working after the subagent watching it was interrupted.
const DEFAULT_LEASE_SEC = 120;
const LEASE_TICK_MS = 2000;
// How long a job waits for the user to answer a permission request before it takes the
// silence as a no.
const DEFAULT_APPROVAL_WAIT_SEC = 30 * 60;

const MAX_REPLY_CHARS = 4000;

function approvalWaitSeconds() {
  const value = Number(process.env.DELEGATE_APPROVAL_WAIT_SEC);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_APPROVAL_WAIT_SEC;
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
 * else is found by its full id, so that it can be followed and answered from anywhere.
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
  // The lease counts from the latest of: the job starting, the last `follow`, and this
  // process waking up after having been suspended.
  let leaseFloorMs = Date.now();
  let lastTickMs = leaseFloorMs;
  let waitingForUser = false;
  const leaseTimer =
    leaseSec > 0
      ? setInterval(() => {
          const now = Date.now();
          // While the job waits for the user's answer, nothing follows it and nothing has
          // to: the delegate is standing still. The lease starts over once they answer.
          if (waitingForUser) {
            leaseFloorMs = now;
            lastTickMs = now;
            return;
          }
          // A tick that arrives far too late means the machine was asleep (or the process
          // was stopped). The follower was frozen too, so the silence proves nothing:
          // give it a full window to come back.
          if (now - lastTickMs > LEASE_TICK_MS * 5) leaseFloorMs = now;
          lastTickMs = now;
          const lastSeen = Math.max(leaseFloorMs, lastHeartbeatMs(cwd, id) ?? 0);
          if (controller.signal.aborted || now - lastSeen <= leaseSec * 1000) return;
          stopError ??= `Stopped because nothing followed the job for ${leaseSec}s. The subagent watching it was probably interrupted.`;
          appendLog(cwd, id, `nothing has followed this job for ${leaseSec}s; stopping it`);
          controller.abort();
        }, LEASE_TICK_MS)
      : null;
  leaseTimer?.unref();

  updateJob(cwd, id, { status: "running", pid: process.pid, startedAt: nowIso(), pending: null });
  createSecret(cwd, id);
  const permissionMode = job.permissionMode ?? FALLBACK_MODE;

  // A backend that needs the user's permission calls askUser and waits. The request is
  // recorded on the job, `follow` shows it, and `answer` delivers the reply. Requests
  // are put to the user one at a time, in the order they came.
  let requestCount = 0;
  let lastRequest = Promise.resolve();
  const waitForAnswer = async (request) => {
    if (controller.signal.aborted) return { decision: "deny", message: null };
    const requestId = `req-${(requestCount += 1)}`;
    takeAnswer(cwd, id); // An answer left over from an earlier request is not for this one.
    // Recorded first, logged second. In the other order a follower could read the log
    // line, miss the request, and then sit out its whole wait before seeing it.
    updateJob(cwd, id, {
      pending: { id: requestId, label: backend.agentName, ...request, askedAt: nowIso(), logOffset: logSize(cwd, id) }
    });
    appendLog(cwd, id, `waiting for the user · ${requestId}: ${backend.agentName} asks to ${request.summary}`);
    waitingForUser = true;
    const waitSec = approvalWaitSeconds();
    const deadline = Date.now() + waitSec * 1000;
    let decision = "deny";
    let message = null;
    let why = "";
    try {
      for (;;) {
        if (controller.signal.aborted) {
          why = "the job was stopped";
          break;
        }
        const answer = takeAnswer(cwd, id);
        if (answer?.request === requestId) {
          decision = answer.decision === "allow" ? "allow" : "deny";
          // A "deny" is also what gets recorded when nobody could be asked at all.
          why = decision === "allow" ? "approved by the user" : "the answer was no";
          // A refusal can come with the user's own words on what to do instead.
          if (decision === "deny" && typeof answer.message === "string" && answer.message.trim()) {
            message = answer.message.trim();
          }
          break;
        }
        if (Date.now() > deadline) {
          why = `nobody answered within ${waitSec}s`;
          break;
        }
        await sleep(300);
      }
    } finally {
      waitingForUser = false;
      leaseFloorMs = Date.now();
      updateJob(cwd, id, { pending: null });
    }
    appendLog(
      cwd,
      id,
      `${requestId}: ${decision === "allow" ? "allowed" : "refused"} (${why})${message ? `\nthe user said: ${message}` : ""}`
    );
    return { decision, message };
  };
  const askUser = (request) => {
    const answered = lastRequest.then(() => waitForAnswer(request));
    lastRequest = answered.catch(() => {});
    return answered;
  };
  appendLog(
    cwd,
    id,
    `started ${job.backend} (permission mode ${permissionMode}: ${job.permissionSource ?? "not recorded"})${job.resumeSessionId ? ", resuming session" : ""}`
  );

  let result;
  try {
    result = await backend.run({
      cwd: job.cwd,
      prompt: job.prompt,
      permissionMode,
      model: job.model,
      effort: job.effort,
      resumeSessionId: job.resumeSessionId,
      signal: controller.signal,
      askUser,
      onEvent: (event) => {
        if (event.type === "session") {
          updateJob(cwd, id, { sessionId: event.sessionId, model: event.model ?? job.model ?? null });
          appendLog(cwd, id, `session ${event.sessionId}${event.model ? ` · model ${event.model}` : ""}`);
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
    { ...latest, sessionId: result.sessionId ?? latest.sessionId ?? null, model: result.model ?? latest.model ?? null },
    result.status,
    { text: result.text, actions: result.actions, usage: result.usage, error: result.error }
  );
}

async function cmdTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    values: ["backend", "permission-mode", CONVERSATION_MODE_FLAG, "model", "effort", "resume", "cwd", "prompt-file", "timeout-sec"]
  });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const permission = resolvePermissionMode({
    explicit: options["permission-mode"],
    conversationMode: options[CONVERSATION_MODE_FLAG]
  });

  const jobs = listJobs(cwd);
  const resume = options.resume ? resolveResume(jobs, options.resume, options.backend) : null;
  if (resume && options.backend && options.backend !== resume.backend) {
    throw new Error(`That session belongs to ${resume.backend}; it cannot be resumed on ${options.backend}.`);
  }
  const backendName = options.backend ?? resume?.backend;
  if (!backendName) throw new Error(`Missing --backend. Choose one of: ${Object.keys(BACKENDS).join(", ")}.`);
  const backend = getBackend(backendName);

  if (resume) {
    // One turn at a time per session: two writers on one session lose or reject a turn.
    const busy = jobs.find(
      (job) => isActive(job) && (job.sessionId === resume.sessionId || job.resumeSessionId === resume.sessionId)
    );
    if (busy) {
      throw new Error(`Session ${resume.sessionId} is busy: job ${busy.id} is still running on it. Wait for it or cancel it first.`);
    }
  }

  let prompt = positionals.join(" ").trim();
  if (options["prompt-file"]) prompt = fs.readFileSync(path.resolve(options["prompt-file"]), "utf8").trim();
  if (!prompt) prompt = (await readStdin()).trim();
  if (!prompt) throw new Error("No task text. Pass it as an argument, with --prompt-file, or on stdin.");

  const timeoutSec = parseTimeoutSec(options["timeout-sec"]);

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
    // Decided per turn: a resumed conversation does not keep the mode of its earlier turns.
    permissionMode: permission.mode,
    permissionSource: permission.source,
    // A resumed session keeps the model and effort it ran with unless told otherwise
    // (agy falls back to its default model on load).
    model: options.model ?? resume?.job?.model ?? null,
    effort: options.effort ?? resume?.job?.effort ?? null,
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

  // Every task runs as a detached worker. This command only starts it and returns the
  // job id; `follow` is how a caller watches it and collects the result.
  const out = fs.openSync(logFile(cwd, job.id), "a");
  const child = spawn(process.execPath, [SCRIPT_PATH, "worker", "--cwd", cwd, "--job-id", job.id], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out]
  });
  child.unref();
  fs.closeSync(out);
  console.log(renderStarted(job));
  return 0;
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

/**
 * Report what a job has done since `--offset`, for a caller that relays progress in steps.
 *
 * It returns when there is something to report, not on a timer: as soon as the job has
 * logged new activity it keeps collecting for a short settle window and then returns
 * that batch. With no activity it returns after --max-wait-sec, and it always returns
 * when the job ends. So a quiet delegate costs the caller almost no calls, and a busy
 * one costs at most one call per settle window.
 *
 * The caller is a model that keeps everything it reads, so by default the activity is
 * shown in a compact form (see lib/progress.mjs). --verbose prints the log as written.
 *
 * Output: the new activity, then either a trailer line with the offset for the next
 * call, or, once the job has ended, the line "=== RESULT ===" and the answer. The answer
 * is the short form (renderAnswer): the caller hands it on word for word, so every line
 * in it is paid for three times over. `result` prints the full record.
 * Every call also marks the job as being followed (see the lease in runJob).
 */
async function cmdFollow(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleans: ["verbose"],
    values: ["cwd", "offset", "max-wait-sec", "settle-sec"]
  });
  if (!positionals[0]) throw new Error("follow needs a job id.");
  const found = findJob(path.resolve(options.cwd ?? process.cwd()), positionals[0]);
  const cwd = found.home;
  let job = found.job;

  const nonNegative = (name, fallback) => {
    if (options[name] === undefined) return fallback;
    const value = Number(options[name]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be zero or more.`);
    return value;
  };
  const offset = nonNegative("offset", 0);
  if (!Number.isInteger(offset)) throw new Error("--offset must be a whole number.");
  const maxWaitMs = nonNegative("max-wait-sec", DEFAULT_MAX_WAIT_SEC) * 1000;
  const settleOverride = nonNegative("settle-sec", null);

  const settleMs = () =>
    settleOverride !== null ? settleOverride * 1000 : settleWindowMs(Date.now() - Date.parse(job.startedAt ?? job.createdAt));

  const startedAt = Date.now();
  let lastBeat = 0;
  let firstNewAt = null;
  // How far the log has been looked at. It moves past stretches that hold nothing the
  // caller could report (the job starting, the model thinking), so that those do not
  // cost the caller a call of its own.
  let seen = offset;
  for (;;) {
    const now = Date.now();
    if (now - lastBeat >= 3000) {
      touchHeartbeat(cwd, job.id);
      lastBeat = now;
    }
    if (!isActive(job)) break;
    // A question the caller has not been shown yet comes back at once. `logOffset` is
    // where the log stood when the question was recorded, so a caller that has read no
    // further than that has not seen it.
    if (job.pending && offset <= (job.pending.logOffset ?? 0)) break;
    if (firstNewAt === null && logSize(cwd, job.id) > seen) firstNewAt = now;
    if (firstNewAt !== null && now - firstNewAt >= settleMs()) {
      const batch = readLogFrom(cwd, job.id, offset);
      if (options.verbose || compactLog(batch.text, { cwd: job.cwd })) break;
      seen = batch.nextOffset;
      firstNewAt = null;
    }
    if (now - startedAt >= maxWaitMs) break;
    await sleep(300);
    job = getJob(cwd, job.id) ?? job;
  }
  touchHeartbeat(cwd, job.id);
  // The question's own log line is written just after the question is recorded. Wait for
  // it, so that the offset handed back lies past it and the question is shown only once.
  for (let tries = 0; job.pending && logSize(cwd, job.id) <= job.pending.logOffset && tries < 40; tries += 1) {
    await sleep(50);
  }

  const { text, nextOffset } = readLogFrom(cwd, job.id, offset);
  const shown = options.verbose ? text.trimEnd() : compactLog(text, { cwd: job.cwd });
  if (shown) console.log(shown);
  if (isActive(job)) {
    const state = job.pending ? "waiting-for-approval" : job.status;
    console.log(`[follow] state=${state} next-offset=${nextOffset} agent="${agentOf(job)}"`);
    if (job.pending) console.log(renderPending(job));
    return 0;
  }
  console.log("=== RESULT ===");
  console.log(renderAnswer(job));
  return 0;
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

/**
 * Deliver the user's answer to the request a job is waiting on.
 *
 * A "deny" is taken as it comes. An "allow" counts only with the job's secret, which the
 * plugin's hook attaches after Claude Code has put the request to the user. Without the
 * hook there is no way to know the user agreed, so nothing is approved.
 */
async function cmdAnswer(argv) {
  const { options, positionals } = parseArgs(argv, { values: ["cwd", TOKEN_FLAG] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const [reference, requestId, decision] = positionals;
  if (!reference || !requestId || !["allow", "deny"].includes(decision)) {
    throw new Error("Usage: answer <job> <request> <allow|deny>");
  }
  const { job, home } = findJob(cwd, reference);
  if (!isActive(job) || job.pending?.id !== requestId) {
    throw new Error(
      `Job ${job.id} is not waiting on ${requestId}. The request may already have been answered, or it timed out. Keep following the job.`
    );
  }
  if (decision === "allow") {
    const secret = readSecret(home, job.id);
    if (!secret || options[TOKEN_FLAG] !== secret) {
      throw new Error(
        "Nothing was approved. An approval has to be confirmed by the user, which happens through the delegate plugin's hook, and this command did not come through it. If the user said no, record that with: answer <job> <request> deny"
      );
    }
  }
  // With a refusal, whatever is on stdin is the user's reply to the delegate.
  const message = decision === "deny" ? (await readStdin()).trim().slice(0, MAX_REPLY_CHARS) : "";
  writeAnswer(home, job.id, { request: requestId, decision, message: message || null, answeredAt: nowIso() });
  const outcome = decision === "allow" ? "allowed" : message ? "refused, and the user's reply was passed on" : "refused";
  console.log(`Recorded for ${job.id}: ${requestId} ${outcome}. Keep following the job.`);
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
  companion.mjs task   --backend <${Object.keys(BACKENDS).join("|")}> [--permission-mode <mode>]
                       [--resume <session-or-job>] [--model <id>] [--effort <level>]
                       [--timeout-sec <n>] [--cwd <dir>] [task text | --prompt-file <path> | stdin]
  companion.mjs follow <job> [--offset <n>] [--max-wait-sec <n>] [--settle-sec <n>] [--verbose]
  companion.mjs answer <job> <request> <allow|deny>     (with deny: the user's reply on stdin, if any)
  companion.mjs status [job] [--all] [--json]
  companion.mjs result [job] [--json]
  companion.mjs cancel [job]
  companion.mjs models [backend] [--json]
  companion.mjs setup  [--json]

task starts a detached job and prints its id. follow returns when the job has done
something new since --offset, or has ended (it then prints the result as well).
When the delegate needs the user's permission, follow shows the request and answer
delivers the reply. An unanswered request counts as refused after ${DEFAULT_APPROVAL_WAIT_SEC / 60} minutes.
A job that nothing follows for ${DEFAULT_LEASE_SEC}s stops itself.
--permission-mode says what the delegate may do this turn: ${MODES.join(", ")}.
These are Claude Code's modes. Left out, the turn follows the mode of the Claude Code
conversation it was started from, and is "${FALLBACK_MODE}" (read-only) when started from anywhere else.
--resume takes the session id printed in a result (or a job id) and continues that conversation.`;

async function main() {
  const [command, ...rawArgv] = process.argv.slice(2);
  // A slash command passes everything the user typed as one quoted string
  // ("task-abc --all"). Only that single-argument form is split. Arguments that arrive
  // already separated are left alone, so that a path with a space in it stays whole.
  const argv =
    command !== "task" && rawArgv.length === 1 ? rawArgv[0].trim().split(/\s+/).filter(Boolean) : rawArgv;
  switch (command) {
    case "task":
      return cmdTask(argv);
    case "worker":
      return cmdWorker(argv);
    case "status":
      return cmdStatus(argv);
    case "result":
      return cmdResult(argv);
    case "follow":
      return cmdFollow(argv);
    case "answer":
      return cmdAnswer(argv);
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
