// The command line as a whole, against job records written straight to a temporary
// state directory. No backend is started. Run from the repository root with: node --test
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const COMPANION = fileURLToPath(new URL("../plugins/delegate/scripts/companion.mjs", import.meta.url));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-")));
process.env.DELEGATE_STATE_DIR = path.join(scratch, "data");
const { appendLog, writeJob, getJob, stateDir, createSecret, takeAnswer } = await import("../plugins/delegate/scripts/lib/state.mjs");
const { addUsage } = await import("../plugins/delegate/scripts/lib/backends/shared.mjs");
const { resolvePermissionMode, allowsMoreThan } = await import("../plugins/delegate/scripts/lib/permission.mjs");

const workspace = path.join(scratch, "my project"); // The space is the point.
fs.mkdirSync(workspace, { recursive: true });

const finished = (id, extra = {}) => ({
  id,
  backend: "codex",
  agentName: "Codex Agent",
  model: "gpt-test",
  cwd: workspace,
  prompt: "a task",
  permissionMode: "default",
  permissionSource: "test",
  status: "completed",
  pid: null,
  sessionId: "session-1",
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  result: { text: "done", actions: [], usage: null, error: null },
  ...extra
});
const companion = (args, options = {}) =>
  spawnSync(process.execPath, [COMPANION, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });

test("arguments that arrive separately are not split, so a path with a space stays whole", () => {
  writeJob(workspace, finished("task-space1"));
  const listed = companion(["status", "--cwd", workspace]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /task-space1/);
});

test("a single quoted argument, as a slash command passes it, is split", () => {
  writeJob(workspace, finished("task-single1"));
  const shown = companion(["status", "task-single1 --json"], { cwd: workspace });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).id, "task-single1");
  assert.equal(companion(["status", ""], { cwd: workspace }).status, 0);
});

test("output larger than a pipe buffer arrives whole", () => {
  const text = `${"x".repeat(400_000)}\nTHE-END`;
  writeJob(workspace, finished("task-big1", { result: { text, actions: [], usage: null, error: null } }));
  const shown = companion(["result", "task-big1"], { cwd: workspace });
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.length > 400_000, `only ${shown.stdout.length} characters arrived`);
  assert.ok(shown.stdout.trimEnd().endsWith("THE-END"));
});

test("an error is still reported, with exit code 2", () => {
  const failed = companion(["result", "task-nope"], { cwd: workspace });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /No job "task-nope"/);
});

test("a job whose process is gone is marked failed, a finished one is left alone", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid; // A pid that has just exited.
  writeJob(workspace, finished("task-orphan1", { status: "running", pid: dead, finishedAt: null, result: null }));
  const orphan = getJob(workspace, "task-orphan1");
  assert.equal(orphan.status, "failed");
  assert.match(orphan.result.error, /exited without recording a result/);
  assert.equal(getJob(workspace, "task-space1").status, "completed");
});

// A job that is waiting for the user, as the worker leaves it: the request recorded with
// the size the log had then, and the request's own log line written after it. Its
// "worker" is this test process, so it counts as alive.
function waitingJob(id) {
  appendLog(workspace, id, "started codex");
  const job = finished(id, {
    status: "running",
    pid: process.pid,
    finishedAt: null,
    result: null,
    pending: { id: "req-1", summary: "run a command", detail: "touch /somewhere/else.txt", askedAt: new Date().toISOString(), logOffset: fs.statSync(path.join(stateDir(workspace), "jobs", `${id}.log`)).size }
  });
  appendLog(workspace, id, "waiting for the user · req-1: Codex asks to run a command");
  return job;
}

test("follow returns at once with a request the caller has not seen", () => {
  writeJob(workspace, waitingJob("task-wait1"));
  const started = Date.now();
  const shown = companion(["follow", "task-wait1", "--offset", "0"], { cwd: workspace });
  assert.ok(Date.now() - started < 5000, "it should not wait for the settle window");
  assert.match(shown.stdout, /state=waiting-for-approval/);
  assert.match(shown.stdout, /=== APPROVAL NEEDED ===\nrequest: req-1\nCodex Agent \(gpt-test\) asks to run a command\n  touch \/somewhere\/else\.txt/);
  // The trailer names the agent and its model, for the caller's progress notes.
  assert.match(shown.stdout, /next-offset=\d+ agent="Codex Agent \(gpt-test\)"/);
  assert.match(shown.stdout, /answer task-wait1 req-1 allow/);
});

test("a caller that has read up to the request, but not the request, is shown it at once", () => {
  const job = writeJob(workspace, waitingJob("task-wait5"));
  const started = Date.now();
  const shown = companion(["follow", "task-wait5", "--offset", String(job.pending.logOffset)], { cwd: workspace });
  assert.ok(Date.now() - started < 5000);
  assert.match(shown.stdout, /=== APPROVAL NEEDED ===/);
  // The offset handed back lies past the request, so the next call does not show it again at once.
  const next = Number(shown.stdout.match(/next-offset=(\d+)/)[1]);
  assert.ok(next > job.pending.logOffset);
});

test("a job is found by its full id from a directory that has nothing to do with it", () => {
  writeJob(workspace, waitingJob("task-far1"));
  const elsewhere = path.join(scratch, "elsewhere");
  fs.mkdirSync(elsewhere);
  const shown = companion(["follow", "task-far1", "--offset", "0"], { cwd: elsewhere });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /request: req-1/);
  assert.equal(companion(["answer", "task-far1", "req-1", "deny"], { cwd: elsewhere }).status, 0);
  assert.equal(takeAnswer(workspace, "task-far1").decision, "deny");
  // Only the full id reaches that far: a prefix could mean a job of any workspace.
  assert.equal(companion(["status", "task-far"], { cwd: elsewhere }).status, 2);
});

test("token counts add up across the messages of one job", () => {
  const one = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
  assert.deepEqual(addUsage(one, { inputTokens: 5, outputTokens: 1, totalTokens: 6 }), { inputTokens: 15, outputTokens: 3, totalTokens: 18 });
  assert.deepEqual(addUsage(null, one), one);
  assert.deepEqual(addUsage(one, null), one);
  assert.equal(addUsage(null, null), null);
});

test("an approval counts only with the job's secret; a refusal needs none", () => {
  writeJob(workspace, waitingJob("task-wait2"));
  const secret = createSecret(workspace, "task-wait2");
  const answer = (...args) => companion(["answer", "task-wait2", ...args], { cwd: workspace });

  const bare = answer("req-1", "allow");
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /Nothing was approved/);
  assert.equal(answer("req-1", "allow", "--token", "guessed").status, 2);
  assert.equal(takeAnswer(workspace, "task-wait2"), null, "a rejected approval leaves no answer behind");

  assert.equal(answer("req-9", "deny").status, 2, "only the request that is waiting can be answered");

  assert.equal(answer("req-1", "allow", "--token", secret).status, 0);
  assert.equal(takeAnswer(workspace, "task-wait2").decision, "allow");
  assert.equal(answer("req-1", "deny").status, 0);
  assert.equal(takeAnswer(workspace, "task-wait2").decision, "deny");
});

test("a refusal passes on the user's reply; an approval never carries one", () => {
  writeJob(workspace, waitingJob("task-wait4"));
  const secret = createSecret(workspace, "task-wait4");
  const answer = (args, input) => companion(["answer", "task-wait4", ...args], { cwd: workspace, input });

  const refused = answer(["req-1", "deny"], "Use other.txt instead.\n");
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /refused, and the user's reply was passed on/);
  assert.deepEqual(
    (({ decision, message }) => ({ decision, message }))(takeAnswer(workspace, "task-wait4")),
    { decision: "deny", message: "Use other.txt instead." }
  );

  assert.equal(answer(["req-1", "deny"], "").status, 0);
  assert.equal(takeAnswer(workspace, "task-wait4").message, null);

  assert.equal(answer(["req-1", "allow", "--token", secret], "ignored text").status, 0);
  assert.equal(takeAnswer(workspace, "task-wait4").message, null);
});

test("no command prints a job's secret", () => {
  writeJob(workspace, waitingJob("task-wait3"));
  const secret = createSecret(workspace, "task-wait3");
  for (const args of [["status", "task-wait3"], ["status", "task-wait3", "--json"], ["status", "--all", "--json"], ["follow", "task-wait3", "--offset", "0", "--verbose"]]) {
    const out = companion(args, { cwd: workspace });
    assert.ok(!out.stdout.includes(secret) && !out.stderr.includes(secret), args.join(" "));
  }
});

test("every worktree of a repository shares one set of job records", () => {
  const repo = path.join(scratch, "repo");
  const linked = path.join(scratch, "repo-linked");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "worktree", "add", "-q", "-b", "linked", linked);
  assert.equal(stateDir(linked), stateDir(repo));
  assert.notEqual(stateDir(repo), stateDir(workspace));
});

test("the state directory does not move when the working directory disappears", () => {
  const gone = path.join(scratch, "short-lived");
  fs.mkdirSync(gone);
  const before = stateDir(gone);
  fs.rmSync(gone, { recursive: true });
  assert.equal(stateDir(gone), before);
});

test("permission modes: an explicit mode wins, then the conversation's, then default", () => {
  assert.equal(resolvePermissionMode({ explicit: "plan", conversationMode: "bypassPermissions" }).mode, "plan");
  assert.equal(resolvePermissionMode({ conversationMode: "acceptEdits" }).mode, "acceptEdits");
  assert.equal(resolvePermissionMode({ conversationMode: "someNewMode" }).mode, "default");
  assert.equal(resolvePermissionMode({}).mode, "default");
  assert.throws(() => resolvePermissionMode({ explicit: "write" }), /Unknown permission mode/);
  assert.ok(allowsMoreThan("bypassPermissions", "auto"));
  assert.ok(allowsMoreThan("acceptEdits", "dontAsk"));
  assert.ok(!allowsMoreThan("plan", "default"));
});

test("the models listing groups ids, folds thinking levels and marks the default", async () => {
  const { renderModels } = await import("../plugins/delegate/scripts/lib/render.mjs");
  const all = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const shown = renderModels([
    {
      backend: "codex",
      agentName: "Codex Agent",
      list: {
        defaultModel: "gpt-6.2-astra",
        defaultEffort: "xhigh",
        note: null,
        models: [
          { id: "gpt-5.2", name: "GPT-5.2", efforts: all.slice(0, 4) },
          { id: "gpt-6.2-sol", name: "GPT-6.2-Sol", efforts: all },
          { id: "gpt-6.2-astra", name: "GPT-6.2-Astra", efforts: all },
          { id: "gpt-6", name: "GPT-6 (Astra)", efforts: ["low", "high"] },
          { id: "gpt-reserve", name: "gpt-reserve", efforts: [] }
        ]
      }
    },
    {
      backend: "agy",
      agentName: "Gemini Agent",
      list: {
        defaultModel: null,
        defaultEffort: null,
        note: null,
        models: [
          { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)", efforts: [], family: "gemini-4-neon", familyName: "Gemini 4 Neon", level: "high" },
          { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)", efforts: [], family: "gemini-4-neon", familyName: "Gemini 4 Neon", level: "low" },
          { id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", efforts: [] }
        ]
      }
    },
    { backend: "other", agentName: "Other Agent", error: "not installed" }
  ]);
  const lines = shown.split("\n").map((line) => line.trimEnd());
  // Newest generation first, a gap between generations, and the default marked.
  const ids = lines.map((line) => line.match(/^  [* ] (gpt-\S+)/)?.[1]).filter(Boolean);
  assert.deepEqual(ids, ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6", "gpt-5.2", "gpt-reserve"]);
  assert.ok(lines.includes("  * gpt-6.2-astra   low → ultra"));
  assert.ok(lines.includes("    gpt-6           low high      GPT-6 (Astra)"), "a name is shown only where it adds to the id");
  assert.ok(lines.includes("    gpt-reserve     -"));
  assert.match(shown, /default: gpt-6\.2-astra, effort xhigh/);
  // One row per model, with its levels in order and the id as a pattern.
  assert.ok(lines.includes("  Gemini 4 Neon           low high   gemini-4-neon-<level>"));
  assert.ok(lines.includes("  Orchestrator (Carbon)   -          gemini-pro-orchestrator"));
  assert.match(shown, /Other Agent \(--backend other\)\n  could not list its models: not installed/);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("the cancel grace period starts even when the abort came first", async (t) => {
  const { afterAbort } = await import("../plugins/delegate/scripts/lib/abort.mjs");
  // The grace timer does not keep a process alive by itself (a real job has its backend
  // process for that), so something else has to while this test waits for it.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const fired = (signal) => new Promise((resolve) => afterAbort(signal, 20, () => resolve(true)));
  const early = new AbortController();
  early.abort();
  assert.equal(await fired(early.signal), true);
  const late = new AbortController();
  const pending = fired(late.signal);
  late.abort();
  assert.equal(await pending, true);
  // Stopping the watch means it never fires.
  const stopped = new AbortController();
  let called = false;
  afterAbort(stopped.signal, 5, () => (called = true))();
  stopped.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(called, false);
});
