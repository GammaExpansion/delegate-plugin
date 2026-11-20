#!/usr/bin/env node
// A stand-in for `codex app-server`, for tests. It speaks just enough of the protocol to
// open a thread and play out one scripted turn, chosen by FAKE_CODEX_SCENARIO:
//
//   silent-end      a subagent works, the main thread gives its final answer, and the
//                   turn is never reported as finished
//   busy-subagent   the same, but the subagent is still at work when the final answer
//                   arrives and finishes a second later
//   normal          the turn is reported as finished right after the final answer
import readline from "node:readline";

const MAIN = "thread-main";
const SUB = "thread-sub";
const TURN = "turn-1";
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "normal";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function playTurn() {
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
  switch (message.method) {
    case "thread/start":
      return send({ id: message.id, result: { thread: { id: MAIN }, model: "fake-model" } });
    case "turn/start":
      send({ id: message.id, result: { turn: { id: TURN } } });
      return void playTurn();
    default:
      return send({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
