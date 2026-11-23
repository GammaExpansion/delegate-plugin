// The bridge of the mod version (plugins/delegate-mod/scripts/bridge.mjs) against the
// stand-ins for `codex app-server` and `agy acp`: one turn per process, events as JSON
// lines, and answers and cancels through its control directory.
// Run from the repository root with: node --test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prependPath, writeFakeBin } from "./fixtures/fake-bin.mjs";

const BRIDGE = fileURLToPath(new URL("../plugins/delegate-mod/scripts/bridge.mjs", import.meta.url));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-bridge-test-")));
writeFakeBin(scratch, "codex", fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)));
writeFakeBin(scratch, "agy", fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url)));

/**
 * Runs one turn. `onEvent(event, child)` sees every event as it comes and may answer an
 * approval or cancel through the control directory.
 */
function runTurn(request, { env = {}, onEvent = () => {} } = {}) {
  const child = spawn(process.execPath, [BRIDGE, "run"], {
    cwd: scratch,
    env: { ...prependPath(process.env, scratch), ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(JSON.stringify({ cwd: scratch, prompt: "do the thing", approvals: "decline", ...request }));
  const events = [];
  let controlDir = null;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === "ready") controlDir = event.controlDir;
    onEvent(event, { controlDir, child });
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      const result = events.find((event) => event.type === "result");
      resolve({ code, events, result, controlDir, stderr });
    });
  });
}

/** Answers a request with one of the agent's own answers (`{ choice }`) or with words (`{ text }`). */
const answer = (controlDir, id, reply) => fs.writeFileSync(path.join(controlDir, `answer-${id}.json`), JSON.stringify(reply));

test("a turn ends with a result and a report, and the control directory is gone", async () => {
  const { code, result, controlDir, events } = await runTurn({ backend: "codex", permission: "read-only" }, { env: { FAKE_CODEX_SCENARIO: "normal" } });
  assert.equal(code, 0);
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.sessionId, "thread-main");
  assert.match(result.report, /^\[delegate\] Codex Agent \(fake-model xHigh\) · completed · \d+\.\ds · read-only\n\nall done$/);
  assert.ok(events.some((event) => event.type === "event" && event.event.type === "session"));
  assert.equal(fs.existsSync(controlDir), false);
});

test("a request for approval is put to the caller with Codex's own answers, and Accept lets the step run", async () => {
  const asked = [];
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, { controlDir }) => {
        if (event.type !== "approval") return;
        asked.push(event.request);
        answer(controlDir, event.id, { choice: "accept" });
      }
    }
  );
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0], choices: undefined }, { kind: "command", title: "touch b.txt", cwd: null, reason: null, choices: undefined });
  assert.deepEqual(
    asked[0].choices.map(({ id, label }) => `${id}=${label}`),
    ["decline=Decline", "accept=Accept", "acceptForSession=Accept for this turn", "cancel=Decline and stop"]
  );
  assert.equal(result.result.text, "the answer was accept");
  assert.doesNotMatch(result.report, /declined/);
});

test("words in place of an answer decline the step and reach Codex during the turn", async () => {
  const { result } = await runTurn(
    { backend: "codex", permission: "read-only", approvals: "ask" },
    {
      env: { FAKE_CODEX_SCENARIO: "approval" },
      onEvent: (event, { controlDir }) => event.type === "approval" && answer(controlDir, event.id, { text: "write it under /tmp instead" })
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
      onEvent: (event, { controlDir }) => event.type === "approval" && answer(controlDir, event.id, { choice: "decline" })
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
      onEvent: (event, { controlDir }) => event.type === "approval" && fs.writeFileSync(path.join(controlDir, "cancel"), "")
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
      onEvent: (event, { controlDir }) => {
        if (event.type !== "approval") return;
        asked.push(event.request);
        answer(controlDir, event.id, { choice: "yes" });
      }
    }
  );
  assert.deepEqual(asked.map(({ kind, title }) => ({ kind, title })), [{ kind: "execute", title: "npm test" }]);
  // agy's own options, its refusal first.
  assert.deepEqual(asked[0].choices.map(({ id, label }) => `${id}=${label}`), ["no=Reject", "yes=Allow"]);
  assert.equal(result.result.status, "completed");
  assert.equal(result.result.text, "Tests passed: 40/40");
  assert.match(result.report, /^\[delegate\] Gemini Agent \(fake-gemini\) · completed/);
});

test("agy: a refused request is declined, and agy is asked to finish without it", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, { controlDir }) => event.type === "approval" && answer(controlDir, event.id, { choice: "no" })
    }
  );
  assert.equal(result.result.text, "I could not run the tests.");
  assert.match(result.report, /declined \(1\):\n- \[execute\] npm test \(pending, permission denied\)/);
});

test("agy: words in place of an answer decline the request and reach agy after the turn", async () => {
  const { result } = await runTurn(
    { backend: "agy", permission: "default", approvals: "ask" },
    {
      env: { FAKE_AGY_SCENARIO: "ask", DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" },
      onEvent: (event, { controlDir }) => event.type === "approval" && answer(controlDir, event.id, { text: "skip the tests, just read the code" })
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
  assert.match(result.report, /· ask-for-approval, no sandbox\n/);
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

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
