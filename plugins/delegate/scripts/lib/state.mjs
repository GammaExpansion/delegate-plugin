// A record of every delegate turn, on disk: one JSON file and one log per turn, grouped
// per workspace. The bridge writes them as a turn runs; `status` and `result` read them,
// from any process, so that what a turn did can be seen while it runs, after it ended,
// and when it was stopped before it could hand back a report.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MAX_JOBS = 50;

export const isActive = (job) => job?.status === "running";

/** Output of a git command run in `cwd`, or "" when it fails (not a repository, no git). */
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Turns are grouped by repository, otherwise by the directory itself. The repository is
 * found through its shared git directory, so that a turn which ran in a linked worktree
 * is listed from the main checkout, and the other way round.
 */
function workspaceRoot(cwd) {
  const printed = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (printed) {
    let commonDir = path.resolve(cwd, printed);
    try {
      commonDir = fs.realpathSync(commonDir);
    } catch {
      // Keep it as printed.
    }
    return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir;
  }
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * Where all records live. The plugin's own data folder, which Claude Code names when it
 * starts the bridge and which a delegate's sandbox cannot write to; the system's temp
 * directory where there is none.
 */
function stateBase() {
  if (process.env.DELEGATE_STATE_DIR) return process.env.DELEGATE_STATE_DIR;
  if (process.env.CLAUDE_PLUGIN_DATA) return path.join(process.env.CLAUDE_PLUGIN_DATA, "turns");
  return path.join(os.tmpdir(), "delegate-plugin");
}

// Resolved once per directory and kept for the life of the process: finding the repository
// runs git, and the answer must not change under a running turn whose directory goes away.
const jobsDirs = new Map();

function jobsDir(cwd) {
  const key = path.resolve(cwd);
  if (!jobsDirs.has(key)) {
    const root = workspaceRoot(cwd);
    const slug = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "workspace";
    const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
    jobsDirs.set(key, path.join(stateBase(), `${slug}-${hash}`));
  }
  const dir = jobsDirs.get(key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where the records of `cwd`'s workspace are kept. */
export const jobsDirOf = (cwd) => jobsDir(cwd);

/** Reads `cwd`'s records from `dir`, for a caller that was told where they are. */
export function pinJobsDir(cwd, dir) {
  jobsDirs.set(path.resolve(cwd), dir);
}

const jobFile = (cwd, id) => path.join(jobsDir(cwd), `${id}.json`);
const logFile = (cwd, id) => path.join(jobsDir(cwd), `${id}.log`);

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

function readJob(cwd, id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(cwd, id), "utf8"));
  } catch {
    return null;
  }
}

export function updateJob(cwd, id, patch) {
  const current = readJob(cwd, id);
  return current ? writeJob(cwd, { ...current, ...patch }) : null;
}

/** Record how a turn ended. */
export function finishJob(cwd, id, status, result) {
  return updateJob(cwd, id, { status, finishedAt: new Date().toISOString(), result });
}

/** Append one entry to a turn's log: a time stamp, then the text, its further lines indented. */
export function appendLog(cwd, id, text) {
  const stamp = new Date().toISOString().slice(11, 19);
  const [first, ...rest] = String(text).split("\n");
  const entry = [`[${stamp}] ${first}`, ...rest.map((line) => `           ${line}`)].join("\n");
  try {
    fs.appendFileSync(logFile(cwd, id), `${entry}\n`, "utf8");
  } catch {
    // The log is best effort: a turn does not fail for it.
  }
}

/**
 * The whole entries of a turn's log from a byte offset on, and the offset to pass next
 * time. An entry still being written is left for the next read.
 */
export function readLogFrom(cwd, id, offset = 0) {
  let buffer;
  try {
    buffer = fs.readFileSync(logFile(cwd, id));
  } catch {
    return { text: "", nextOffset: offset };
  }
  const start = Math.min(Math.max(0, offset), buffer.length);
  const end = buffer.lastIndexOf(0x0a) + 1;
  if (end <= start) return { text: "", nextOffset: start };
  return { text: buffer.subarray(start, end).toString("utf8"), nextOffset: end };
}

export function readLogTail(cwd, id, lines = 15) {
  try {
    return fs.readFileSync(logFile(cwd, id), "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** A turn whose bridge is gone without having recorded how it ended is marked failed. */
function reconcile(cwd, job) {
  if (!isActive(job) || isAlive(job.pid)) return job;
  // The bridge records the outcome and then exits. If it did both between the read that
  // produced `job` and the check above, the record on disk is already final.
  const latest = readJob(cwd, job.id);
  if (!latest || !isActive(latest)) return latest ?? job;
  return finishJob(cwd, job.id, "failed", {
    ...(latest.result ?? {}),
    error: "The turn's process ended without recording a result: it was killed, or Claude Code was closed while it ran."
  });
}

/** The turns of `cwd`'s workspace, newest first. */
export function listJobs(cwd) {
  const jobs = [];
  for (const name of fs.readdirSync(jobsDir(cwd))) {
    if (!name.endsWith(".json")) continue;
    const job = readJob(cwd, name.slice(0, -".json".length));
    if (job) jobs.push(reconcile(cwd, job));
  }
  return jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * A turn by its id, from this workspace or, since an id is unique across all of them,
 * from any other. Returns the record and the directory to read its log with, or null.
 */
export function findJob(cwd, id) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
  const here = readJob(cwd, id);
  if (here) return { job: reconcile(cwd, here), home: cwd };
  let groups = [];
  try {
    groups = fs.readdirSync(stateBase());
  } catch {
    return null;
  }
  for (const group of groups) {
    let job;
    try {
      job = JSON.parse(fs.readFileSync(path.join(stateBase(), group, `${id}.json`), "utf8"));
    } catch {
      continue;
    }
    if (typeof job?.cwd !== "string") continue;
    // The record says where the turn ran. Tie that directory to the place the record was
    // found in, in case it would no longer resolve there (a worktree since removed).
    jobsDirs.set(path.resolve(job.cwd), path.join(stateBase(), group));
    return { job: reconcile(job.cwd, job), home: job.cwd };
  }
  return null;
}

/**
 * Keep the MAX_JOBS turns that ended last; never remove a running one. Going by when a
 * turn ended keeps a long one that has only just finished, however many started after it.
 */
export function pruneJobs(cwd) {
  const endedAt = (job) => Date.parse(job.finishedAt ?? job.createdAt) || 0;
  const finished = listJobs(cwd).filter((job) => !isActive(job)).sort((a, b) => endedAt(b) - endedAt(a));
  for (const job of finished.slice(MAX_JOBS)) {
    for (const file of [jobFile(cwd, job.id), logFile(cwd, job.id)]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Ignore.
      }
    }
  }
}
