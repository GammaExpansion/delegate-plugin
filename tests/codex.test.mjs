// The Codex backend against a stand-in for `codex app-server`, for the things a real
// Codex cannot be made to do on demand. Run from the repository root with: node --test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-codex-test-")));
// The backend runs whatever `codex` is first on PATH.
fs.writeFileSync(path.join(scratch, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
process.env.PATH = `${scratch}${path.delimiter}${process.env.PATH}`;
const { codexBackend } = await import("../plugins/delegate/scripts/lib/backends/codex.mjs");

async function runScenario(scenario) {
  process.env.FAKE_CODEX_SCENARIO = scenario;
  const events = [];
  const started = Date.now();
  const result = await codexBackend.run({
    cwd: scratch,
    prompt: "do the thing",
    permissionMode: "default",
    onEvent: (event) => events.push(event),
    askUser: async () => ({ decision: "deny", message: null })
  });
  const said = events.filter((event) => event.type !== "session").map((event) => event.text ?? event.action?.kind);
  return { result, said, tookMs: Date.now() - started };
}

test("a turn that is never reported as finished ends once the final answer is in", async () => {
  const { result, said, tookMs } = await runScenario("silent-end");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "all done");
  assert.ok(said.some((text) => /did not report the turn as finished/.test(text)), said.join(" | "));
  assert.ok(tookMs >= 1400 && tookMs < 8000, `took ${tookMs} ms`);
});

test("what Codex's own subagent does is shown under its name", async () => {
  const { result, said } = await runScenario("normal");
  assert.equal(result.status, "completed");
  assert.ok(said.includes("starting subagent: explorer"), said.join(" | "));
  assert.ok(said.includes("subagent explorer: found it"), said.join(" | "));
  // The subagent's message is progress. It is not part of the answer.
  assert.equal(result.text, "all done");
  assert.ok(result.actions.some((action) => action.kind === "subagent"));
  assert.ok(!said.some((text) => /did not report the turn as finished/.test(text)), "a turn that reports its end is not second-guessed");
});

test("the turn is not taken as finished while a subagent is still at work", async () => {
  const { result, tookMs } = await runScenario("busy-subagent");
  assert.equal(result.status, "completed");
  // The subagent goes on for a second after the final answer. Only then does the wait begin.
  assert.ok(tookMs >= 2400, `ended after ${tookMs} ms, before the subagent was done`);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
