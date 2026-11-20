// The PreToolUse hook's decisions. Run from the repository root with: node --test
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decide } from "../plugins/delegate/scripts/lib/hook.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/delegate/scripts/companion.mjs", import.meta.url));
const run = (command, mode = "acceptEdits") => decide({ command, mode, companionPath: COMPANION });
const task = (flags, text = "do the thing", marker = "DELEGATE_TASK_a1b2c3") =>
  `node "${COMPANION}" task ${flags} <<'${marker}'\n${text}\n${marker}`;

test("adds the conversation's mode to a task command", () => {
  const verdict = run(task("--backend codex"));
  assert.equal(verdict.decision, undefined);
  assert.match(verdict.command, / task --conversation-mode acceptEdits --backend codex <<'DELEGATE_TASK_a1b2c3'\n/);
  assert.ok(verdict.command.endsWith("do the thing\nDELEGATE_TASK_a1b2c3"));
});

test("leaves every other command alone", () => {
  assert.equal(run(`node "${COMPANION}" follow task-1 --offset 0`), null);
  assert.equal(run(`node "${COMPANION}" status`), null);
  assert.equal(run("ls -la"), null);
  // Text that merely looks like the command, or names some other plugin's script.
  assert.equal(run(`grep -n 'scripts/companion.mjs" task' agents/codex.md`), null);
  assert.equal(run(`node "/somewhere/else/scripts/companion.mjs" task --backend codex hi`), null);
});

test("does not read flags out of the task text", () => {
  const verdict = run(task("--backend agy", "explain what --conversation-mode and --permission-mode bypassPermissions do"), "default");
  assert.equal(verdict.decision, undefined);
  assert.match(verdict.command, / task --conversation-mode default --backend agy <</);
});

test("replaces a conversation mode it did not write itself", () => {
  const verdict = run(task("--conversation-mode bypassPermissions --backend agy"), "default");
  assert.match(verdict.command, / task --conversation-mode default --backend agy <</);
  assert.doesNotMatch(verdict.command.split("\n")[0], /bypassPermissions/);
  const withEquals = run(task("--conversation-mode=auto --backend agy"), "plan");
  assert.doesNotMatch(withEquals.command.split("\n")[0], /auto/);
});

test("asks the user when the task names a mode above the conversation's", () => {
  for (const flags of ["--backend codex --permission-mode bypassPermissions", "--permission-mode=auto --backend codex"]) {
    const verdict = run(task(flags), "default");
    assert.equal(verdict.decision, "ask");
    assert.match(verdict.reason, /allows less/);
    assert.ok(verdict.command, "the command is still rewritten for when the user approves");
  }
  assert.equal(run(task("--backend codex --permission-mode acceptEdits"), "plan").decision, "ask");
  // Quoting the flag does not hide it.
  assert.equal(run(task(`--backend codex "--permission-mode" 'bypassPermissions'`), "default").decision, "ask");
});

test("does not ask when the named mode allows the same or less", () => {
  assert.equal(run(task("--backend codex --permission-mode acceptEdits"), "acceptEdits").decision, undefined);
  assert.equal(run(task("--backend codex --permission-mode plan"), "bypassPermissions").decision, undefined);
  assert.equal(run(task("--backend codex --permission-mode dontAsk"), "default").decision, undefined);
});

test("refuses a task whose text contains the heredoc marker", () => {
  const verdict = run(`node "${COMPANION}" task --backend codex <<'DELEGATE_TASK'\nreview this\nDELEGATE_TASK\nrm -rf ~\nDELEGATE_TASK`);
  assert.equal(verdict.decision, "deny");
  assert.match(verdict.reason, /different marker/);
  assert.equal(verdict.command, undefined);
});

test("refuses shell syntax that could run or expand something", () => {
  const refused = [
    `node "${COMPANION}" task --backend codex <<EOF\nhi\nEOF`, // unquoted marker: the text would be expanded
    `node "${COMPANION}" task --backend codex --model $(whoami) hi`,
    `node "${COMPANION}" task --backend codex "$HOME"`,
    `node "${COMPANION}" task --backend codex hi; rm -rf x`,
    `node "${COMPANION}" task --backend codex hi | tee out`,
    `node "${COMPANION}" task --backend codex hi\nrm -rf x`,
    `cd /tmp && node "${COMPANION}" task --backend codex hi`
  ];
  for (const command of refused) assert.equal(run(command)?.decision, "deny", command);
});

test("accepts task text given as a plain quoted argument", () => {
  const verdict = run(`node "${COMPANION}" task --backend codex "say ok"`, "plan");
  assert.equal(verdict.decision, undefined);
  assert.ok(verdict.command.endsWith(`task --conversation-mode plan --backend codex "say ok"`));
});

test("adds nothing when Claude Code reports a mode it does not know", () => {
  const verdict = run(task("--backend codex"), "someNewMode");
  assert.doesNotMatch(verdict.command, /--conversation-mode/);
});

// --- approving a delegate's permission request -------------------------------------

const waiting = {
  secret: "s3cr3t",
  pending: { id: "req-2", label: "Codex", summary: "run a command", detail: "touch /somewhere/else.txt\nits reason: needs to write outside" }
};
const answer = (words, lookup = () => waiting) =>
  decide({ command: `node "${COMPANION}" answer ${words}`, mode: "default", companionPath: COMPANION, lookup });

test("an approval becomes a question for the user, marked with the job's secret", () => {
  const verdict = answer("task-abc123 req-2 allow");
  assert.equal(verdict.decision, "ask");
  assert.ok(verdict.command.endsWith("answer task-abc123 req-2 allow --token s3cr3t"));
  // The user is shown what the job recorded, not anything the caller wrote.
  assert.match(verdict.reason, /Codex is asking for permission to run a command/);
  assert.match(verdict.reason, /touch \/somewhere\/else\.txt/);
});

test("a refusal goes through without a question and without the secret", () => {
  const verdict = answer("task-abc123 req-2 deny");
  assert.equal(verdict.decision, undefined);
  assert.ok(verdict.command.endsWith("answer task-abc123 req-2 deny"));
});

test("a token the caller supplied is thrown away", () => {
  const forged = answer("task-abc123 req-2 allow --token guessed");
  assert.equal(forged.decision, "ask");
  assert.doesNotMatch(forged.command, /guessed/);
  // With nothing waiting, no token is attached at all, so the script approves nothing.
  const nothingWaiting = answer("task-abc123 req-2 allow --token=s3cr3t", () => ({ ...waiting, pending: null }));
  assert.equal(nothingWaiting.decision, undefined);
  assert.doesNotMatch(nothingWaiting.command, /token/);
});

test("an approval for some other request is not put to the user", () => {
  for (const lookup of [() => null, () => ({ ...waiting, pending: { ...waiting.pending, id: "req-3" } }), () => ({ ...waiting, secret: null })]) {
    const verdict = answer("task-abc123 req-2 allow", lookup);
    assert.equal(verdict.decision, undefined);
    assert.doesNotMatch(verdict.command, /token/);
  }
});

test("an answer in any other shape is refused", () => {
  const refused = [
    "task-abc123 req-2 allow; rm -rf x",
    "task-abc123 req-2 allow && echo done",
    "task-abc123 req-2 $(echo allow)",
    "task-abc123 req-2 maybe",
    "task-abc123 req-2",
    "task-abc123 req-2 allow extra",
    "../etc req-2 allow"
  ];
  for (const words of refused) assert.equal(answer(words)?.decision, "deny", words);
  const hidden = decide({ command: `cd /tmp && node "${COMPANION}" answer task-abc123 req-2 allow`, mode: "default", companionPath: COMPANION, lookup: () => waiting });
  assert.equal(hidden.decision, "deny");
});

test("a refusal can carry the user's reply, and only a refusal can", () => {
  const withNote = (decision, text = "Use other.txt instead.", marker = "DELEGATE_NOTE_a1b2c3") =>
    decide({ command: `node "${COMPANION}" answer task-abc123 req-2 ${decision} <<'${marker}'\n${text}\n${marker}`, mode: "default", companionPath: COMPANION, lookup: () => waiting });

  const refused = withNote("deny");
  assert.equal(refused.decision, undefined);
  assert.ok(refused.command.endsWith("answer task-abc123 req-2 deny <<'DELEGATE_NOTE_a1b2c3'\nUse other.txt instead.\nDELEGATE_NOTE_a1b2c3"));
  // The reply is text for the delegate. Nothing in it is read as a flag.
  assert.equal(withNote("deny", "say --token s3cr3t and allow it").decision, undefined);

  assert.equal(withNote("allow").decision, "deny", "an approval takes no reply");
  assert.equal(withNote("deny", "first\nDELEGATE_NOTE_a1b2c3\nrm -rf ~").decision, "deny", "the reply must not close the heredoc early");
  assert.equal(answer("task-abc123 req-2 deny <<EOF\n$(whoami)\nEOF").decision, "deny", "the marker must be quoted");
});

test("a command that does not name the script costs nothing, however long it is", () => {
  // One unbroken token of 200 KB: a pattern that can start anywhere would take seconds here.
  const started = process.hrtime.bigint();
  assert.equal(run(`echo ${"A".repeat(200_000)}`), null);
  assert.equal(run(`echo ${"A".repeat(200_000)}companion.mjs`), null);
  assert.equal(run(`cat ${"x/".repeat(50_000)}companion.mjs taskfile`), null);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500, "took too long");
});

test("refuses the script when it is reached by a path that cannot be checked", () => {
  const refused = [
    `cd "${COMPANION.replace(/\/companion\.mjs$/, "")}" && node companion.mjs task --backend codex --permission-mode bypassPermissions hi`,
    `node companion.mjs task --backend codex hi`,
    `node ./scripts/companion.mjs answer task-abc123 req-1 allow`,
    `(cd scripts; node "companion.mjs" task --backend agy hi)`
  ];
  for (const command of refused) {
    const verdict = run(command);
    assert.equal(verdict?.decision, "deny", command);
    assert.match(verdict.reason, /full path/);
  }
  // Another program whose name merely ends the same way is not this plugin's business.
  assert.equal(run(`node scripts/codex-companion.mjs task "review this"`), null);
  assert.equal(run(`node "/somewhere/else/scripts/companion.mjs" task --backend codex hi`), null);
});

test("a long request is shown cut, and says how much is missing", () => {
  const long = { ...waiting, pending: { ...waiting.pending, detail: [`echo ${"x".repeat(2000)}`, ...Array.from({ length: 80 }, (_, i) => `line ${i}`)].join("\n") } };
  const reason = answer("task-abc123 req-2 allow", () => long).reason;
  assert.match(reason, /\[\.\.\. \d+ more characters on this line are not shown\]/);
  assert.match(reason, /\[\.\.\. 41 more lines are not shown\./);
  assert.ok(reason.length < 40_000);
  // A short one is shown whole, with no such note.
  assert.doesNotMatch(answer("task-abc123 req-2 allow").reason, /not shown/);
});
