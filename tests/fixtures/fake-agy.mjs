#!/usr/bin/env node
// A stand-in for `agy acp`, for tests. It speaks just enough of the protocol to open a
// session and play out one scripted turn, chosen by FAKE_AGY_SCENARIO:
//
//   background   a command is still running when the turn ends; it finishes afterwards
//                and agy carries on by itself with the rest of its answer
//   late-close   the command finishes just before the turn ends, and the rest of the
//                answer still comes afterwards
//   crash        the command is still running when the turn ends, and then agy dies
//   silent       the command is still running when the turn ends, and nothing more comes
//   declined     agy asks to run a command, never reports the call as ended, and ends
//                its turn without a word; told that nobody can approve, it answers
import readline from "node:readline";

const SESSION = "agy-session";
const scenario = process.env.FAKE_AGY_SCENARIO ?? "background";
const PERMISSION_ID = 77;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (fields) => send({ method: "session/update", params: { sessionId: SESSION, update: fields } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const stepEnds = () => update({ sessionUpdate: "usage_update", used: 100, size: 1000 });
const tool = (status, first = false) =>
  update({ sessionUpdate: first ? "tool_call" : "tool_call_update", toolCallId: "t1", kind: "execute", title: "npm test", status });
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const endTurn = (id) => send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });

let prompts = 0;
let firstPromptId = null;

async function playTurn(id) {
  prompts += 1;
  if (scenario === "declined") {
    if (prompts > 1) {
      say("I could not run the tests.");
      stepEnds();
      return endTurn(id);
    }
    firstPromptId = id;
    tool("pending", true);
    return send({
      id: PERMISSION_ID,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "t1", kind: "execute", title: "npm test" },
        options: [
          { optionId: "yes", kind: "allow_once", name: "Allow" },
          { optionId: "no", kind: "reject_once", name: "Reject" }
        ]
      }
    });
  }

  tool("in_progress", true);
  say("Started the tests.");
  if (scenario === "late-close") {
    tool("completed");
    endTurn(id);
    await later(400);
    say("Tests passed: 40/40");
    return stepEnds();
  }
  stepEnds();
  endTurn(id);
  if (scenario === "crash") {
    await later(300);
    process.stderr.write("agy: out of memory\n");
    process.exit(3);
  }
  if (scenario === "background") {
    await later(600);
    tool("completed");
    await later(200);
    say("Tests passed: 40/40");
    stepEnds();
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  // A message with an id and no method is the client's reply to a request of ours.
  if (!message.method) {
    // The call is left as it was, with no word on how it ended, and the turn just stops.
    if (message.id === PERMISSION_ID) endTurn(firstPromptId);
    return;
  }
  switch (message.method) {
    case "session/new":
      return send({ id: message.id, result: { sessionId: SESSION, models: { currentModelId: "fake-gemini" } } });
    case "session/prompt":
      return void playTurn(message.id);
    default:
      return send({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
