// Job records on disk. One JSON file per job, grouped per workspace, so
// `status` / `result` / `cancel` work across separate companion invocations.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_JOBS = 50;
const ACTIVE = new Set(["queued", "running"]);

export function isActive(job) {
  return ACTIVE.has(job?.status);
}

/** Output of a git command run in `cwd`, or "" when it fails (not a repository, no git). */
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** A path as git prints it (possibly relative to `cwd`), as a physical absolute path. */
function physical(cwd, printed) {
  const absolute = path.resolve(cwd, printed);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

// One git call per directory answers both questions asked of it below.
const gitDirsByCwd = new Map();

/** The git directory `cwd` is in and the one all its worktrees share, or null outside a repository. */
function gitDirs(cwd) {
  const key = path.resolve(cwd);
  if (!gitDirsByCwd.has(key)) {
    const [gitDir, commonDir] = git(cwd, ["rev-parse", "--git-dir", "--git-common-dir"]).split("\n");
    gitDirsByCwd.set(key, gitDir && commonDir ? { gitDir: physical(cwd, gitDir), commonDir: physical(cwd, commonDir) } : null);
  }
  return gitDirsByCwd.get(key);
}

/**
 * Jobs are grouped by repository, otherwise by the directory itself. The repository is
 * found through its shared git directory, so every linked worktree lands in the same
 * group as the main checkout: a delegate that ran in a worktree can be inspected and
 * cancelled from the main checkout, and the other way round.
 */
function workspaceRoot(cwd) {
  const commonDir = gitDirs(cwd)?.commonDir;
  if (commonDir) return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * The linked worktree `cwd` is in, or null when `cwd` is in the main checkout or not in
 * a repository at all.
 * @returns {{ path: string, branch: string | null } | null}
 */
export function linkedWorktree(cwd) {
  const dirs = gitDirs(cwd);
  if (!dirs || dirs.gitDir === dirs.commonDir) return null;
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { path: git(cwd, ["rev-parse", "--show-toplevel"]) || path.resolve(cwd), branch: branch && branch !== "HEAD" ? branch : null };
}

// Resolved once per directory and then kept for the life of the process. Finding the
// repository means running git, which is too slow to repeat on every log line, and the
// answer must not change under a running job: if its directory disappears (a worktree
// that Claude Code cleaned up), the job still has to finish in the record it started in.
const stateDirs = new Map();

export function stateDir(cwd) {
  const key = path.resolve(cwd);
  if (!stateDirs.has(key)) stateDirs.set(key, resolveStateDir(cwd));
  return stateDirs.get(key);
}

/**
 * The directory all job records live under. It must come out the same in every process
 * that touches a job: the command that starts it, its worker, and every `wait`. Claude
 * Code does not give shell commands a plugin data directory, so the system's temp
 * directory is used.
 */
function stateBase() {
  return process.env.DELEGATE_STATE_DIR || path.join(os.tmpdir(), "delegate-plugin");
}

function resolveStateDir(cwd) {
  const root = workspaceRoot(cwd);
  const base = stateBase();
  const slug = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "workspace";
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
  return path.join(base, `${slug}-${hash}`);
}

function jobsDir(cwd) {
  const dir = path.join(stateDir(cwd), "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jobFile(cwd, id) {
  return path.join(jobsDir(cwd), `${id}.json`);
}

export function logFile(cwd, id) {
  return path.join(jobsDir(cwd), `${id}.log`);
}

/** Every message to and from the backend, written only when DELEGATE_TRACE is set. */
export function traceFile(cwd, id) {
  return path.join(jobsDir(cwd), `${id}.trace.jsonl`);
}

/** Touched by `wait`; the worker reads it to tell whether anyone is still watching. */
function heartbeatFile(cwd, id) {
  return path.join(jobsDir(cwd), `${id}.heartbeat`);
}

/** How far into the job's log its follower has been told about. */
const cursorFile = (cwd, id) => path.join(jobsDir(cwd), `${id}.cursor`);

export function readCursor(cwd, id) {
  try {
    const value = Number(fs.readFileSync(cursorFile(cwd, id), "utf8").trim());
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeCursor(cwd, id, offset) {
  try {
    fs.writeFileSync(cursorFile(cwd, id), `${offset}\n`, "utf8");
  } catch {
    // Best effort: the worst case is that some activity is described twice.
  }
}

export function touchHeartbeat(cwd, id) {
  try {
    fs.writeFileSync(heartbeatFile(cwd, id), `${Date.now()}\n`, "utf8");
  } catch {
    // Best effort.
  }
}

/** When the job was last followed, in ms since the epoch, or null if never. */
export function lastHeartbeatMs(cwd, id) {
  try {
    return fs.statSync(heartbeatFile(cwd, id)).mtimeMs;
  } catch {
    return null;
  }
}

export function logSize(cwd, id) {
  try {
    return fs.statSync(logFile(cwd, id)).size;
  } catch {
    return 0;
  }
}

export function newJobId() {
  return `task-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

export function writeJob(cwd, job) {
  const file = jobFile(cwd, job.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return job;
}

export function readJob(cwd, id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(cwd, id), "utf8"));
  } catch {
    return null;
  }
}

export function updateJob(cwd, id, patch) {
  const current = readJob(cwd, id);
  if (!current) return null;
  return writeJob(cwd, { ...current, ...patch });
}

// The job log's framing: an entry opens with a time stamp, and the further lines of a
// multi-line entry are indented to sit under its text.
const LOG_STAMP = /^\[\d\d:\d\d:\d\d\] /;
const LOG_INDENT = " ".repeat(11);

/** Append one entry to the job log. */
export function appendLog(cwd, id, text) {
  const stamp = new Date().toISOString().slice(11, 19);
  const [first, ...rest] = String(text).split("\n");
  const entry = [`[${stamp}] ${first}`, ...rest.map((line) => `${LOG_INDENT}${line}`)].join("\n");
  try {
    fs.appendFileSync(logFile(cwd, id), `${entry}\n`, "utf8");
  } catch {
    // Logging is best effort.
  }
}

/**
 * Split a stretch of the log back into its entries. Each is `{ head, body, rest }`: the
 * first line as written, the same line without its stamp, and the lines that follow it.
 */
export function splitLogEntries(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (LOG_STAMP.test(line) || !entries.length) entries.push({ head: line, body: line.replace(LOG_STAMP, ""), rest: [] });
    else entries[entries.length - 1].rest.push(line.startsWith(LOG_INDENT) ? line.slice(LOG_INDENT.length) : line);
  }
  return entries;
}

/**
 * Read whole lines of the log starting at a byte offset.
 * Returns the text and the offset to pass next time.
 */
export function readLogFrom(cwd, id, offset = 0) {
  let buffer;
  try {
    buffer = fs.readFileSync(logFile(cwd, id));
  } catch {
    return { text: "", nextOffset: offset };
  }
  const start = Math.min(Math.max(0, offset), buffer.length);
  const end = buffer.lastIndexOf(0x0a) + 1; // Stop after the last complete line.
  if (end <= start) return { text: "", nextOffset: start };
  return { text: buffer.subarray(start, end).toString("utf8"), nextOffset: end };
}

export function readLogTail(cwd, id, lines = 15) {
  try {
    const all = fs.readFileSync(logFile(cwd, id), "utf8").trimEnd().split("\n");
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** A job whose owning process died without recording an outcome is marked failed. */
function reconcile(cwd, job) {
  if (!isActive(job)) return job;
  const ageMs = Date.now() - Date.parse(job.createdAt);
  const orphaned = job.pid ? !isAlive(job.pid) : ageMs > 30_000;
  if (!orphaned) return job;
  // The worker writes its outcome and then exits. If it did both between the read that
  // produced `job` and the check above, the record on disk is already final: read it
  // again, and only a record that is still unfinished, for the same process, is orphaned.
  const latest = readJob(cwd, job.id);
  if (!latest) return job;
  if (!isActive(latest) || latest.pid !== job.pid) return latest;
  return finishJob(cwd, latest, "failed", {
    ...(latest.result ?? {}),
    error: "The job's process exited without recording a result."
  });
}

/** Record how a job ended. */
export function finishJob(cwd, job, status, result) {
  return writeJob(cwd, { ...job, status, finishedAt: new Date().toISOString(), result });
}

/** Newest first. */
export function listJobs(cwd) {
  const dir = jobsDir(cwd);
  const jobs = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const job = readJob(cwd, name.slice(0, -".json".length));
    if (job) jobs.push(reconcile(cwd, job));
  }
  return jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function getJob(cwd, id) {
  const job = readJob(cwd, id);
  return job ? reconcile(cwd, job) : null;
}

/**
 * Find a job by its full id wherever it was started, for a caller that is not in that
 * job's repository or directory. A job id is unique across all of them. Returns the job
 * and the directory to use for every further call about it, or null.
 */
export function locateJob(id) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  let groups;
  try {
    groups = fs.readdirSync(stateBase());
  } catch {
    return null;
  }
  for (const group of groups) {
    const dir = path.join(stateBase(), group);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(dir, "jobs", `${id}.json`), "utf8"));
    } catch {
      continue;
    }
    if (typeof job?.cwd !== "string") continue;
    // The record says where the job was started. Tie that directory to the place the
    // record was found in, in case it would no longer resolve there (a deleted worktree).
    stateDirs.set(path.resolve(job.cwd), dir);
    return { job: reconcile(job.cwd, job), home: job.cwd };
  }
  return null;
}

/** Where a job's answer is saved for a caller that handed its message over in a file. */
export function answerFileOf(job) {
  return job.exchangeDir ? path.join(job.exchangeDir, `${job.id}.md`) : null;
}

/**
 * Keep the MAX_JOBS jobs that finished last; never remove an active one. Going by when a
 * job finished, not when it started, keeps a long job that has only just ended, whose
 * answer may not have been read yet, however many shorter ones started after it.
 */
export function pruneJobs(cwd, jobs = listJobs(cwd)) {
  const endedAt = (job) => Date.parse(job.finishedAt ?? job.createdAt) || 0;
  const finished = jobs.filter((job) => !isActive(job)).sort((a, b) => endedAt(b) - endedAt(a));
  for (const job of finished.slice(MAX_JOBS)) {
    const files = [jobFile, logFile, traceFile, heartbeatFile, cursorFile].map((fileOf) => fileOf(cwd, job.id));
    // The answer saved for the job's caller goes with the record. Only the file this
    // plugin would itself have written there is removed, whatever the record names.
    if (job.answerFile && job.answerFile === answerFileOf(job)) files.push(job.answerFile);
    for (const file of files) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Ignore.
      }
    }
  }
}
