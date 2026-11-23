#!/usr/bin/env node
// A stand-in for `codex app-server`, for tests. It speaks just enough of the protocol to
// open a thread and play out one scripted turn, chosen by FAKE_CODEX_SCENARIO:
//
//   silent-end      a subagent works, the main thread gives its final answer, and the
//                   turn is never reported as finished
//   busy-subagent   the same, but the subagent is still at work when the final answer
//                   arrives and finishes a second later
//   normal          the turn is reported as finished right after the final answer
//   approval        Codex asks to run a command, and says in its answer what it was told,
//                   and any message it was sent with turn/steer while it waited after a no
//   permissions     Codex asks for more permissions (item/permissions/requestApproval), and
//                   says in its answer what it was granted
//
// With FAKE_CODEX_RESUME_FAILS=1, thread/resume fails, as for a session that is gone.
//
// It also records the settings each thread was opened with, in FAKE_CODEX_RECORD if set.
import fs from "node:fs";
import readline from "node:readline";

const MAIN = "thread-main";
const SUB = "thread-sub";
const TURN = "turn-1";
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "normal";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const APPROVAL_ID = 900;

function askApproval() {
  notify("item/started", { threadId: MAIN, turnId: TURN, item: { id: "x1", type: "commandExecution", command: "touch b.txt", status: "inProgress" } });
  send({ id: APPROVAL_ID, method: "item/commandExecution/requestApproval", params: { threadId: MAIN, turnId: TURN, itemId: "x1", command: "touch b.txt" } });
}

const steered = [];

async function afterApproval(decision) {
  // After a no, a message may follow with turn/steer: give it time to arrive.
  if (decision !== "accept") await later(200);
  const status = decision === "accept" ? "completed" : "declined";
  notify("item/completed", { threadId: MAIN, turnId: TURN, item: { id: "x1", type: "commandExecution", command: "touch b.txt", status, exitCode: decision === "accept" ? 0 : null } });
  const heard = steered.length ? ` · steered: ${steered.join(" | ")}` : "";
  notify("item/completed", { threadId: MAIN, turnId: TURN, item: { id: "m2", type: "agentMessage", phase: "final_answer", text: `the answer was ${decision}${heard}` } });
  notify("turn/completed", { threadId: MAIN, turn: { id: TURN, status: "completed" } });
}

const record = (entry) => {
  if (process.env.FAKE_CODEX_RECORD) fs.appendFileSync(process.env.FAKE_CODEX_RECORD, `${JSON.stringify(entry)}\n`);
};

const PERMISSIONS_ID = 901;

async function playTurn() {
  if (scenario === "approval") return askApproval();
  if (scenario === "permissions") {
    return send({
      id: PERMISSIONS_ID,
      method: "item/permissions/requestApproval",
      params: { threadId: MAIN, turnId: TURN, itemId: "p1", reason: "needs the device", permissions: { fileSystem: { write: ["/dev/bus/usb"] }, network: { enabled: true } } }
    });
  }
  notify("thread/started", { thread: { id: SUB, name: "explorer" } });
  notify("item/started", { threadId: MAIN, turnId: TURN, item: { id: "c1", type: "collabAgentToolCall", tool: "spawn_agent", status: "inProgress", receiverThreadIds: [SUB] } });
  notify("turn/started", { threadId: SUB, turn: { id: "turn-sub" } });
  notify("item/completed", { threadId: SUB, turnId: "turn-sub", item: { id: "m1", type: "agentMessage", text: "found it" } });
  notify("item/completed", { threadId: MAIN, turnId: TURN, item: { id: "c1", type: "collabAgentToolCall", tool: "spawn_agent", status: "completed", receiverThreadIds: [SUB] } });
  if (scenario !== "busy-subagent") notify("turn/completed", { threadId: SUB, turn: { id: "turn-sub", status: "completed" } });
  notify("item/completed", { threadId: MAIN, turnId: TURN, item: { id: "m2", type: "agentMessage", phase: "final_answer", text: "all done" } });
  if (scenario === "busy-subagent") {
    await later(1000);
    notify("turn/completed", { threadId: SUB, turn: { id: "turn-sub", status: "completed" } });
  }
  if (scenario === "normal") notify("turn/completed", { threadId: MAIN, turn: { id: TURN, status: "completed" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  // A message with an id and no method is the client's reply to a request of ours.
  if (!message.method) {
    if (message.id === APPROVAL_ID) void afterApproval(message.result?.decision);
    if (message.id === PERMISSIONS_ID) {
      const granted = JSON.stringify(message.result);
      notify("item/completed", { threadId: MAIN, turnId: TURN, item: { id: "m3", type: "agentMessage", phase: "final_answer", text: `granted ${granted}` } });
      notify("turn/completed", { threadId: MAIN, turn: { id: TURN, status: "completed" } });
    }
    return;
  }
  switch (message.method) {
    case "thread/resume":
      if (process.env.FAKE_CODEX_RESUME_FAILS === "1") return send({ id: message.id, error: { code: -32600, message: "no rollout found for thread" } });
    // falls through
    case "thread/start":
      record({ method: message.method, sandbox: message.params.sandbox, approvalsReviewer: message.params.approvalsReviewer });
      return send({ id: message.id, result: { thread: { id: MAIN }, model: "fake-model", reasoningEffort: "xhigh" } });
    case "turn/steer":
      steered.push(message.params.input?.[0]?.text ?? "");
      return send({ id: message.id, result: { turnId: TURN } });
    case "turn/start":
      send({ id: message.id, result: { turn: { id: TURN } } });
      return void playTurn();
    default:
      return send({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
