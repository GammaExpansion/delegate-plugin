// The agy backend against a stand-in for `agy acp`, for what a real agy cannot be made to
// do on demand: carrying on after its turn has ended, dying, and going quiet.
// Run from the repository root with: node --test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeFakeBin } from "./fixtures/fake-bin.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-agy.mjs", import.meta.url));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-agy-test-")));
// The backend runs whatever `agy` is first on PATH.
writeFakeBin(scratch, "agy", FAKE);
process.env.PATH = `${scratch}${path.delimiter}${process.env.PATH}`;
const { agyBackend } = await import("../plugins/delegate/scripts/lib/backends/agy.mjs");

async function runScenario(scenario, env = {}, options = {}) {
  Object.assign(process.env, { FAKE_AGY_SCENARIO: scenario, ...env });
  const events = [];
  const started = Date.now();
  try {
    const result = await agyBackend.run({ cwd: scratch, prompt: "run the tests", onEvent: (event) => events.push(event), ...options });
    const said = events.map((event) => event.text ?? `${event.action?.kind} ${event.action?.status}`);
    return { result, said, tookMs: Date.now() - started };
  } finally {
    for (const name of Object.keys(env)) delete process.env[name];
  }
}

test("a turn that ends with a command still running is waited out, and the rest of the answer is kept", async () => {
  const { result, said } = await runScenario("background");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Started the tests.\n\nTests passed: 40/40");
  assert.ok(said.some((text) => /ended its turn with a command still running/.test(text)), said.join(" | "));
  assert.deepEqual(result.actions.map((action) => action.status), ["completed"]);
});

test("a command that ends just before the turn does still gets its follow-up", async () => {
  const { result } = await runScenario("late-close");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Started the tests.\n\nTests passed: 40/40");
});

test("agy dying while it carries on is a failure, with what it had said kept", async () => {
  const { result } = await runScenario("crash");
  assert.equal(result.status, "failed");
  assert.match(result.error, /agy stopped while it was still at work after ending its turn.*exited unexpectedly \(code=3/s);
  assert.match(result.error, /out of memory/);
  assert.equal(result.text, "Started the tests.");
});

test("a background command with no sign of life is given up on: the answer stands, with a note", async () => {
  const { result, tookMs } = await runScenario("silent", { DELEGATE_AGY_BACKGROUND_WAIT_SEC: "1" });
  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
  assert.equal(result.text, "Started the tests.");
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /left a command running and gave no sign of life for 1s.*npm test/);
  assert.ok(tookMs < 6000, `took ${tookMs} ms`);
});

test("given up on with nothing said, it is a failure", async () => {
  const { result } = await runScenario("wordless", { DELEGATE_AGY_BACKGROUND_WAIT_SEC: "1" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /left a command running and gave no sign of life for 1s.*npm test/);
  assert.equal(result.text, "");
});

test("a command agy started to keep running is not waited for", async () => {
  const { result, said, tookMs } = await runScenario("daemon", { DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "The server is up.");
  assert.deepEqual(result.actions.map(({ status, daemon }) => ({ status, daemon })), [{ status: "in_progress", daemon: true }]);
  assert.deepEqual(result.notes, ["agy left a command running, as it meant to: npm run dev"]);
  assert.ok(!said.some((text) => /waiting for it to carry on/.test(text)), said.join(" | "));
  assert.ok(tookMs < 3000, `it waited ${tookMs} ms on a command that was never going to end`);
});

test("history that a resumed session goes on replaying after it has loaded is not part of the new turn", async () => {
  const { result, said } = await runScenario("replay-late", {}, { resumeSessionId: "agy-session" });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "NEW ANSWER");
  assert.deepEqual(result.actions, []);
  assert.ok(!said.some((text) => /old command|OLD ANSWER/.test(text)), said.join(" | "));
});

test("a turn that ends at once without the model having been called is a failure, not an old answer", async () => {
  const { result } = await runScenario("replay-swallowed", {}, { resumeSessionId: "agy-session" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /without calling the model/);
  assert.equal(result.text, "");
  assert.deepEqual(result.actions, []);
});

test("a declined call that agy never closes is not waited on, and agy is asked to finish without it", async () => {
  const { result, said, tookMs } = await runScenario("declined", { DELEGATE_AGY_BACKGROUND_WAIT_SEC: "30" });
  assert.equal(result.status, "completed");
  assert.equal(result.text, "I could not run the tests.");
  assert.deepEqual(result.actions.map(({ status, permission }) => ({ status, permission })), [{ status: "pending", permission: "denied" }]);
  assert.ok(said.some((text) => /stopped at a declined request without answering/.test(text)), said.join(" | "));
  assert.ok(tookMs < 5000, `it waited ${tookMs} ms on a call that was never going to run`);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
