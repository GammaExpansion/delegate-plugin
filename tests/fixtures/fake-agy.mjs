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
//   wordless     the same, and agy had not said anything either
//   daemon       agy starts a command that is meant to keep running (a server), gives its
//                answer and ends its turn; the command never ends
//   declined     agy asks to run a command, never reports the call as ended, and ends
//                its turn without a word; told that nobody can approve, it answers
//   ask          agy asks to run a command; allowed, it runs it and answers, and refused,
//                it behaves as in "declined"; sent the user's words after the turn, it
//                answers with them
//   ask-always   the same, but agy offers only "Always allow" and no refusal
//
// With FAKE_AGY_LOAD_FAILS=1, session/load fails, as for a session that is gone.
// With FAKE_AGY_NO_AUTO=1, session/set_mode refuses auto, as agy does where it lacks its sandbox.
//
// A resumed session (`session/load`) replays its history as updates. A real agy answers
// the load while a long history is still on its way, which these two play out:
//
//   replay-late       the history goes on after the load is answered, pauses, goes on
//                     again, and the prompt is then answered as usual
//   replay-swallowed  the same history and then some more, in the middle of which the
//                     prompt arrives: it comes back at once as a finished turn in which
//                     the model was never called
import readline from "node:readline";

const SESSION = "agy-session";
const scenario = process.env.FAKE_AGY_SCENARIO ?? "background";
const PERMISSION_ID = 77;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (fields) => send({ method: "session/update", params: { sessionId: SESSION, update: fields } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const stepEnds = () => update({ sessionUpdate: "usage_update", used: 100, size: 1000 });
const tool = (status, first = false, more = {}) =>
  update({ sessionUpdate: first ? "tool_call" : "tool_call_update", toolCallId: "t1", kind: "execute", title: "npm test", status, ...more });
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const endTurn = (id) => send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
const opened = (id) => send({ id, result: { sessionId: SESSION, models: { currentModelId: "fake-gemini" } } });
/** agy says something, and that is its whole turn from there. */
const answer = (id, text) => {
  say(text);
  stepEnds();
  endTurn(id);
};

let prompts = 0;
let firstPromptId = null;
let lastPrompt = "";

/** One step of an earlier turn, the way agy replays it: a call that is already over, and text. */
const replayStep = (n) => {
  tool("completed", true, { toolCallId: `old-${n}`, title: `old command ${n}` });
  say(`OLD ANSWER ${n}`);
};

async function loadSession(id) {
  update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "the earlier task" } });
  replayStep(1);
  opened(id);
  await later(20);
  replayStep(2);
  await later(300);
  replayStep(3);
  stepEnds();
}

async function playTurn(id) {
  prompts += 1;
  if (scenario === "replay-swallowed") {
    replayStep(4); // History was still on its way when the prompt came, which is why it is dropped.
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (scenario === "replay-late") {
    await later(500); // A model takes its time, so history still on its way would land in this turn.
    return answer(id, "NEW ANSWER");
  }
  if (scenario === "daemon") {
    tool("in_progress", true, { title: "npm run dev", rawInput: { CommandLine: "npm run dev", IsDaemon: true, WaitMsBeforeAsync: 500 } });
    return answer(id, "The server is up.");
  }
  if (scenario === "declined" || scenario === "ask" || scenario === "ask-always") {
    if (prompts > 1) {
      if (scenario === "ask" && lastPrompt.includes("the user did not allow it")) return answer(id, `Heard: ${lastPrompt.split("\n").pop()}`);
      return answer(id, "I could not run the tests.");
    }
    firstPromptId = id;
    tool("pending", true);
    return send({
      id: PERMISSION_ID,
      method: "session/request_permission",
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: "t1", kind: "execute", title: "npm test" },
        options:
          scenario === "ask-always"
            ? [{ optionId: "always", kind: "allow_always", name: "Always allow" }]
            : [
                { optionId: "yes", kind: "allow_once", name: "Allow" },
                { optionId: "no", kind: "reject_once", name: "Reject" }
              ]
      }
    });
  }

  tool("in_progress", true);
  if (scenario !== "wordless") say("Started the tests.");
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
    if (message.id !== PERMISSION_ID) return;
    if ((scenario === "ask" && message.result?.outcome?.optionId === "yes") || (scenario === "ask-always" && message.result?.outcome?.optionId === "always")) {
      tool("completed");
      return answer(firstPromptId, "Tests passed: 40/40");
    }
    // The call is left as it was, with no word on how it ended, and the turn just stops.
    endTurn(firstPromptId);
    return;
  }
  switch (message.method) {
    case "session/new":
      return opened(message.id);
    case "session/load":
      if (process.env.FAKE_AGY_LOAD_FAILS === "1") return send({ id: message.id, error: { code: -32002, message: "session not found" } });
      return void loadSession(message.id);
    case "session/prompt":
      lastPrompt = message.params?.prompt?.[0]?.text ?? "";
      return void playTurn(message.id);
    case "session/set_mode":
      if (process.env.FAKE_AGY_NO_AUTO === "1" && message.params?.modeId === "auto") {
        return send({ id: message.id, error: { code: -32603, message: "Auto mode is not available: it needs the OS terminal sandbox" } });
      }
      return send({ id: message.id, result: {} });
    default:
      return send({ id: message.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
