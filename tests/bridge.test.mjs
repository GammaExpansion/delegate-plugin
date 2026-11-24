// The bridge (plugins/delegate/scripts/bridge.mjs) against the
// stand-ins for `codex app-server` and `agy acp`: one turn per process, events as JSON
// lines, and answers and cancels through its control directory.
// Run from the repository root with: node --test
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prependPath, writeFakeBin } from "./fixtures/fake-bin.mjs";

const BRIDGE = fileURLToPath(new URL("../plugins/delegate/scripts/bridge.mjs", import.meta.url));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-bridge-test-")));
writeFakeBin(scratch, "codex", fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)));
writeFakeBin(scratch, "agy", fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url)));

// The records of the turns these tests run go to a directory of their own.
const STATE = { DELEGATE_STATE_DIR: path.join(scratch, "state") };

/** What `bridge.mjs status` or `result` prints here. */
function ask(command, ...args) {
  const run = spawnSync(process.execPath, [BRIDGE, command, ...args], { cwd: scratch, env: { ...process.env, ...STATE }, encoding: "utf8" });
  return { code: run.status, out: run.stdout.trim(), err: run.stderr.trim() };
}

/**
 * Runs one turn. `onEvent(event, child)` sees every event as it comes and may answer an
 * approval or cancel through the control directory.
 */
function runTurn(request, { env = {}, onEvent = () => {} } = {}) {
  const child = spawn(process.execPath, [BRIDGE, "run"], {
    cwd: scratch,
    env: { ...prependPath(process.env, scratch), ...STATE, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(JSON.stringify({ cwd: scratch, prompt: "do the thing", approvals: "decline", ...request }));
  const events = [];
  let controlDir = null;
  let token = null;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === "ready") ({ controlDir, token } = event);
    onEvent(event, { controlDir, token, child });
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      const result = events.find((event) => event.type === "result");
      resolve({ code, events, result, controlDir, stderr });
    });
  });
}

/** Answers a request with one of the agent's own answers (`{ choice }`) or with words (`{ text }`), signed with the turn's token. */
const answer = (ctx, id, reply) => fs.writeFileSync(path.join(ctx.controlDir, `answer-${id}.json`), JSON.stringify({ ...reply, token: ctx.token }));
const cancel = (ctx) => fs.writeFileSync(path.join(ctx.controlDir, "cancel"), JSON.stringify({ token: ctx.token }));

test("a turn ends with a result and a report, and the control directory is gone", async () => {
  const { code, result, controlDir, events } = await runTurn({ backend: "codex", permission: "read-only" }, { env: { FAKE_CODEX_SCENARIO: "normal" } });
  assert.equal(code, 0);
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.sessionId, "thread-main");
  // The session's id is under the headline: it is what --resume takes to continue it later.
  assert.match(result.report, /^\[delegate\] Codex Agent \(fake-model xHigh\) · completed · \d+\.\ds · read-only · task-[a-z0-9]+\nsession: thread-main\n\nall done$/);
  assert.ok(events.some((event) => event.type === "event" && event.event.type === "session"));
  assert.equal(fs.existsSync(controlDir), false);
});

test("a request for approval is put to the caller with Codex's own answers, and Accept lets the step run", async () => {
  const asked = [];
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, ctx) => {
        if (event.type !== "approval") return;
        asked.push(event.request);
        answer(ctx, event.id, { choice: "accept" });
      }
    }
  );
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0], choices: undefined }, { kind: "command", title: "touch b.txt", cwd: null, reason: null, choices: undefined });
  assert.deepEqual(
    asked[0].choices.map(({ id, label }) => `${id}=${label}`),
    [
      "decline=No, continue without it",
      "accept=Yes, just this once",
      "acceptForSession=Yes, and don't ask again in this session",
      "cancel=No, and stop Codex"
    ]
  );
  assert.equal(result.result.text, "the answer was accept");
  assert.doesNotMatch(result.report, /declined/);
});

test("words in place of an answer decline the step and reach Codex during the turn", async () => {
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, ctx) => event.type === "approval" && answer(ctx, event.id, { text: "write it under /tmp instead" })
    }
  );
  assert.equal(
    result.result.text,
    "the answer was decline · steered: About your request to run `touch b.txt`: the user did not allow it, and wrote:\n\nwrite it under /tmp instead"
  );
});

test("a no declines the step, and the report says the user was asked", async () => {
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, ctx) => event.type === "approval" && answer(ctx, event.id, { choice: "decline" })
    }
  );
  assert.equal(result.result.text, "the answer was decline");
  assert.match(result.report, /declined \(1\):\n- \[command\] touch b\.txt \(declined\)\nnote: the user was asked/);
});

test("in a mode where nobody is asked, nothing is put to the caller", async () => {
  const { events, result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "decline", mode: "plan" },
    { env: { FAKE_CODEX_SCENARIO: "approval" } }
  );
  assert.ok(!events.some((event) => event.type === "approval"));
  assert.equal(result.result.text, "the answer was decline");
  assert.match(result.report, /note: this conversation is in plan permission mode, in which nobody is asked/);
});

test("a cancel through the control directory stops the turn while it waits for an answer", async () => {
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, ctx) => event.type === "approval" && cancel(ctx)
    }
  );
  assert.equal(result.result.status, "cancelled");
  assert.match(result.report, /· cancelled ·/);
});

test("SIGTERM stops the turn the same way, and the result still comes out", async () => {
  const { result, code } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, { child }) => event.type === "approval" && child.kill("SIGTERM")
    }
  );
  assert.equal(code, 0);
  assert.equal(result.result.status, "cancelled");
});

test("agy: an allowed request runs, and the answer comes after it", async () => {
  const asked = [];
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, ctx) => {
        if (event.type !== "approval") return;
        asked.push(event.request);
        answer(ctx, event.id, { choice: "accept" });
      }
    }
  );
  assert.deepEqual(asked.map(({ kind, title }) => ({ kind, title })), [{ kind: "execute", title: "npm test" }]);
  // Codex's words for agy's own options; "don't ask again" only where agy offers it. That
  // "accept" reaches agy as its own allow_once shows in the answer below.
  assert.deepEqual(asked[0].choices, [
    { id: "decline", label: "No, continue without it", allow: false },
    { id: "accept", label: "Yes, just this once", allow: true },
    { id: "cancel", label: "No, and stop Antigravity", allow: false, stop: true }
  ]);
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.text, "Tests passed: 40/40");
  assert.match(result.report, /^\[delegate\] Gemini Agent \(fake-gemini\) · completed/);
});

test("agy: a refused request is declined, and agy is asked to finish without it", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, ctx) => event.type === "approval" && answer(ctx, event.id, { choice: "decline" })
    }
  );
  assert.equal(result.result.text, "I could not run the tests.");
  assert.match(result.report, /declined \(1\):\n- \[execute\] npm test \(pending, permission denied\)/);
});

test("agy: \"No, and stop\" refuses the request and ends the turn", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, ctx) => event.type === "approval" && answer(ctx, event.id, { choice: "cancel" })
    }
  );
  assert.equal(result.result.status, "cancelled");
  assert.match(result.report, /declined \(1\):\n- \[execute\] npm test/);
});

test("agy: words in place of an answer decline the request and reach agy after the turn", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, ctx) => event.type === "approval" && answer(ctx, event.id, { text: "skip the tests, just read the code" })
    }
  );
  assert.equal(result.result.text, "Heard: skip the tests, just read the code");
});

test("a turn without the sandbox opens Codex with none, and the headline says so", async () => {
  const record = path.join(scratch, "codex-record.jsonl");
  const { result } = await runTurn(
    { backend: "codex", permission: "ask-for-approval", sandbox: "disabled" },
    { env: { FAKE_CODEX_SCENARIO: "normal", FAKE_CODEX_RECORD: record } }
  );
  const opened = fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(opened.map(({ method, sandbox }) => ({ method, sandbox })), [{ method: "thread/start", sandbox: "danger-full-access" }]);
  assert.match(result.report, /· ask-for-approval, no sandbox · task-[a-z0-9]+\n/);
});

test("a request the bridge cannot read is reported as an error event", async () => {
  const child = spawn(process.execPath, [BRIDGE, "run"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end("not json");
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 2);
  assert.equal(JSON.parse(out.trim()).type, "error");
});

test("an answer without the turn's token is passed over, even one written before the question", async () => {
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, ctx) => {
        if (event.type === "ready") {
          // What a delegate's sandboxed command could write there: no token, or a wrong one.
          for (let id = 1; id <= 3; id += 1) fs.writeFileSync(path.join(ctx.controlDir, `answer-${id}.json`), JSON.stringify({ choice: "acceptForSession" }));
          fs.writeFileSync(path.join(ctx.controlDir, "cancel"), JSON.stringify({ token: "0".repeat(48) }));
        }
        if (event.type === "approval") setTimeout(() => answer(ctx, event.id, { choice: "decline" }), 400);
      }
    }
  );
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.text, "the answer was decline");
});

test("an answer file read before it is complete is read again", async () => {
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, ctx) => {
        if (event.type !== "approval") return;
        fs.writeFileSync(path.join(ctx.controlDir, `answer-${event.id}.json`), "");
        setTimeout(() => answer(ctx, event.id, { choice: "accept" }), 400);
      }
    }
  );
  assert.equal(result.result.text, "the answer was accept");
});

test("Codex's request for more permissions shows what it asks for, and is answered in its own shape", async () => {
  const asked = [];
  const allowed = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "permissions" },
      onEvent: (event, ctx) => {
        if (event.type !== "approval") return;
        asked.push(event.request);
        answer(ctx, event.id, { choice: "accept" });
      }
    }
  );
  assert.equal(asked[0].kind, "permissions");
  assert.equal(asked[0].title, "write /dev/bus/usb; network access");
  assert.deepEqual(asked[0].choices.map(({ id }) => id), ["decline", "accept"]);
  assert.equal(allowed.result.result.text, 'granted {"permissions":{"fileSystem":{"write":["/dev/bus/usb"]},"network":{"enabled":true}},"scope":"turn"}');

  const refused = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    { env: { FAKE_CODEX_SCENARIO: "permissions" }, onEvent: (event, ctx) => event.type === "approval" && answer(ctx, event.id, { choice: "decline" }) }
  );
  assert.equal(refused.result.result.text, 'granted {"permissions":{},"scope":"turn"}');
  assert.match(refused.result.report, /declined \(1\):\n- \[permissions\] write \/dev\/bus\/usb; network access \(declined\)/);
});

test("Codex: a session that cannot be resumed is replaced by a new one, with a note", async () => {
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", resumeSessionId: "gone-thread" },
    { env: { FAKE_CODEX_SCENARIO: "normal", FAKE_CODEX_RESUME_FAILS: "1" } }
  );
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.sessionId, "thread-main");
  assert.match(result.report, /note: the earlier Codex session could not be resumed \(no rollout found for thread\), so this turn started a new one/);
});

test("agy: a session that cannot be resumed is replaced by a new one, with a note", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "default", resumeSessionId: "gone-session" },
    { env: { FAKE_AGY_SCENARIO: "replay-late", FAKE_AGY_LOAD_FAILS: "1" } }
  );
  assert.equal(result.result.status, "completed");
  assert.match(result.report, /note: the earlier agy session could not be resumed \(session not found\), so this turn started a new one/);
});

test("a session the turn names itself must be there: the turn fails and no new session is started", async () => {
  const record = path.join(scratch, "codex-named-record.jsonl");
  const codex = await runTurn(
    { backend: "codex", permission: "read-only", resumeSessionId: "gone-thread", resumeNamed: true },
    { env: { FAKE_CODEX_SCENARIO: "normal", FAKE_CODEX_RESUME_FAILS: "1", FAKE_CODEX_RECORD: record } }
  );
  assert.equal(codex.result.result.status, "failed");
  assert.match(codex.result.report, /^\[delegate\] Codex Agent · failed · \d+\.\ds · read-only · task-[a-z0-9]+\nerror: Codex could not resume session gone-thread: no rollout found for thread$/);
  assert.equal(fs.existsSync(record), false, "no thread was opened");
  assert.ok(!codex.events.some((event) => event.type === "event" && event.event.type === "session"));

  const agy = await runTurn(
    { backend: "agy", permission: "default", resumeSessionId: "gone-session", resumeNamed: true },
    { env: { FAKE_AGY_SCENARIO: "replay-late", FAKE_AGY_LOAD_FAILS: "1" } }
  );
  assert.equal(agy.result.result.status, "failed");
  assert.match(agy.result.report, /error: agy could not resume session gone-session: session not found$/);
  assert.doesNotMatch(agy.result.report, /^session: /m);
  assert.ok(!agy.events.some((event) => event.type === "event" && event.event.type === "session"));
});

test("agy: with no refusal of its own on offer, one is put first, and answers cancelled", async () => {
  const asked = [];
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask-always", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, ctx) => {
        if (event.type !== "approval") return;
        asked.push(event.request);
        answer(ctx, event.id, { choice: "decline" });
      }
    }
  );
  assert.deepEqual(asked[0].choices.map(({ id, label, allow }) => `${id}=${label}=${allow}`), ["decline=No, continue without it=false", "always=Always allow=true"]);
  assert.equal(result.result.text, "I could not run the tests.");
});

test("agy: stopped while the user is asked, the request is answered cancelled and the turn ends", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    { env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" }, onEvent: (event, ctx) => event.type === "approval" && cancel(ctx) }
  );
  assert.equal(result.result.status, "cancelled");
});

test("agy: where it refuses its auto mode, the turn runs with accept-edits, and the report says so", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "auto", mode: "auto" },
    { env: { FAKE_AGY_SCENARIO: "late-close", FAKE_AGY_NO_AUTO: "1" } }
  );
  assert.equal(result.result.status, "completed");
  assert.match(result.report, /^\[delegate\] Gemini Agent \(fake-gemini\) · completed · \d+\.\ds · accept-edits · task-[a-z0-9]+\n/);
  assert.match(result.report, /note: agy does not offer its auto mode here \(Auto mode is not available: it needs the OS terminal sandbox\), so this turn ran with accept-edits/);
});

test("agy: auto cannot run without its sandbox, and a turn that fails without a word ends at its error", async () => {
  const { result } = await runTurn({ backend: "agy", permission: "auto", sandbox: "disabled" });
  assert.equal(result.result.status, "failed");
  assert.match(result.report, /^\[delegate\] Gemini Agent · failed · \d+\.\ds · auto, no sandbox · task-[a-z0-9]+\nerror: Antigravity's "auto" runs its commands in agy's sandbox, so it cannot run with --sandbox disabled\. Pick another --permission\.$/);
});

test("a turn is on record: status lists it and shows its log, result prints its answer, actions and usage", async () => {
  const { result, events } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    { env: { FAKE_CODEX_SCENARIO: "approval" }, onEvent: (event, ctx) => event.type === "approval" && answer(ctx, event.id, { choice: "accept" }) }
  );
  const id = events.find((event) => event.type === "ready").jobId;
  assert.match(id, /^task-[a-z0-9]+$/);
  assert.ok(result.report.split("\n")[0].endsWith(` · ${id}`), "the report's headline ends with the turn's id");

  const list = ask("status");
  assert.equal(list.code, 0);
  assert.match(list.out, /^TURN\s+AGENT\s+STATUS\s+PERMISSION\s+TIME\s+TASK\n/);
  assert.match(list.out, new RegExp(`${id}\\s+Codex Agent \\(fake-model xHigh\\)\\s+completed\\s+read-only\\s+\\S+\\s+do the thing`));

  const detail = ask("status", id);
  assert.match(detail.out, new RegExp(`^\\[delegate\\] Codex Agent \\(fake-model xHigh\\) · completed · \\S+ · read-only · ${id}\ntask: do the thing\n`));
  assert.match(detail.out, /--- recent activity ---\n\[\d\d:\d\d:\d\d\] started codex with read-only\n/);
  assert.match(detail.out, /asked the user: command touch b\.txt/);
  assert.match(detail.out, /the user answered: accept/);
  assert.match(detail.out, /finished: completed\n\nFinished\. Its full record: result task-/);

  const full = ask("result", id);
  assert.match(full.out, /session: thread-main {2}\(continue this conversation from a new delegate with --resume thread-main\)/);
  assert.match(full.out, /--- final message ---\nthe answer was accept/);
  // Without an id, the turn that ended last.
  assert.equal(ask("result").out, full.out);
  assert.match(ask("status", "task-nosuch").err, /No turn "task-nosuch" is on record/);
});

test("a turn that was stopped is on record with what it had done", async () => {
  const { events } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    { env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" }, onEvent: (event, ctx) => event.type === "approval" && cancel(ctx) }
  );
  const id = events.find((event) => event.type === "ready").jobId;
  const full = ask("result", id);
  assert.match(full.out, /· cancelled · /);
  assert.match(full.out, /note: the run was stopped before it finished\./);
  assert.match(full.out, /--- actions \(1\) ---\n- \[execute\] npm test/);
});

test("a turn whose bridge was killed is on record as failed, not as running for ever", async () => {
  let id = null;
  await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, ctx) => {
        if (event.type === "ready") id = event.jobId;
        if (event.type === "approval") ctx.child.kill("SIGKILL");
      }
    }
  );
  assert.match(ask("status", id).out, /· failed · [^\n]*\n[\s\S]*error: The turn's process ended without recording a result/);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
