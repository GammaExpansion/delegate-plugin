// Codex backend: drives `codex app-server` (stdio JSON-RPC).
//
// Permissions: what Codex may do without asking is decided by its OS sandbox, chosen
// from the task's permission mode (see POLICY). When it wants more than that, it asks,
// and who answers also depends on the mode: the user, Codex's own automatic reviewer,
// or nobody.
import { execFileSync } from "node:child_process";
import { afterAbort, CANCEL_GRACE_MS } from "../abort.mjs";
import { StdioRpcClient } from "../rpc.mjs";
import { clipHead, clipTail, oneLine } from "../text.mjs";
import { CLIENT_INFO, refusalReply, refuseUnknownRequest, toUsage } from "./shared.mjs";

// Token-level deltas are skipped: progress is reported per finished item
// (a message, a reasoning summary, a command with its output), which is enough to follow along.
const QUIET_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta"
];

// Claude Code permission mode -> Codex settings. Each one is a preset Codex has itself
// (the names in its /permissions menu).
//   - plan, default     -> "Read Only". Codex asks before it edits or leaves the sandbox,
//                          and the user answers. In plan mode edits are refused outright.
//   - dontAsk           -> the same sandbox, but nothing is asked: what the sandbox does
//                          not allow simply fails. That is what the mode means.
//   - acceptEdits       -> "Ask for approval": the workspace sandbox, no network. Codex
//                          asks the user before it steps outside.
//   - auto              -> "Approve for me" (`codex --approve-for-me` sets these same
//                          three values): its automatic reviewer answers, not the user.
//   - bypassPermissions -> "Full Access": no sandbox, network included, nothing asked.
// `whenAsked` says what happens to an approval request that reaches this client.
const ASK_THE_USER = { approvalPolicy: "on-request", approvalsReviewer: "user", whenAsked: "user" };
const POLICY = {
  plan: { sandbox: "read-only", ...ASK_THE_USER, refuseEdits: true },
  default: { sandbox: "read-only", ...ASK_THE_USER },
  dontAsk: { sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user", whenAsked: "refuse" },
  acceptEdits: { sandbox: "workspace-write", ...ASK_THE_USER },
  auto: { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review", whenAsked: "user" },
  bypassPermissions: { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user", whenAsked: "refuse" }
};

// Codex normally says when a turn is over. If its final answer has arrived, none of its
// own agents is still at work, and that word has not come after this long, the turn is
// taken as finished. Without this a lost notification would leave the job running forever.
const INFERRED_FINISH_MS = 1500;

// The sandbox as a full policy object. It is sent with every turn, so that a resumed
// conversation takes this turn's sandbox, not that of its last turn, and so that the
// user's own Codex config cannot widen or narrow what a mode means.
const SANDBOX_POLICY = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", networkAccess: false },
  "danger-full-access": { type: "dangerFullAccess" }
};


async function handshake(client) {
  await client.request("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: QUIET_NOTIFICATIONS }
  });
  client.notify("initialized");
}

function describeChange(change) {
  const kind = typeof change.kind === "string" ? change.kind : change.kind?.type ?? "change";
  return `${kind} ${change.path}`;
}

/** A command Codex wants approved, in the words the user will be shown. */
function describeCommand(params) {
  const command = Array.isArray(params?.command) ? params.command.join(" ") : String(params?.command ?? "");
  const network = params?.networkApprovalContext;
  const lines = [command || "(Codex did not say which command)"];
  if (network?.host) lines.push(`network access to: ${network.host}`);
  if (params?.reason) lines.push(`its reason: ${oneLine(params.reason, 300)}`);
  return { summary: network?.host ? "use the network" : "run a command", detail: lines.join("\n") };
}

/** A file change Codex wants approved. The request names the item; the item has the paths. */
function describeFileChange(params, item) {
  const changes = (item?.changes ?? []).map(describeChange);
  const lines = changes.length ? changes.slice(0, 12) : ["(Codex did not say which files)"];
  if (changes.length > 12) lines.push(`and ${changes.length - 12} more`);
  if (params?.grantRoot) lines.push(`it also asks to write anywhere under: ${params.grantRoot}`);
  if (params?.reason) lines.push(`its reason: ${oneLine(params.reason, 300)}`);
  return { summary: "change files", detail: lines.join("\n") };
}

function toAction(item) {
  switch (item.type) {
    case "commandExecution":
      return { kind: "command", title: item.command, status: item.status, exitCode: item.exitCode };
    case "fileChange":
      return { kind: "edit", title: (item.changes ?? []).map(describeChange).join(", "), status: item.status };
    case "mcpToolCall":
      return { kind: "tool", title: `${item.server}.${item.tool}`, status: item.status };
    case "webSearch":
      return { kind: "search", title: item.query ?? "web search", status: "completed" };
    case "collabAgentToolCall":
      return { kind: "subagent", title: item.tool ?? "collaboration", status: item.status };
    default:
      return null;
  }
}

export const codexBackend = {
  name: "codex",
  label: "Codex",
  agentName: "Codex Agent",

  check() {
    const info = { installed: false, version: null, auth: "unknown", hint: null };
    try {
      info.version = execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      info.installed = true;
    } catch {
      info.hint = "Install with `npm install -g @openai/codex`.";
      return info;
    }
    try {
      // Exit code only: the output can include part of an API key, so it is not echoed.
      execFileSync("codex", ["login", "status"], { stdio: "ignore" });
      info.auth = "ok";
    } catch {
      info.auth = "missing";
      info.hint = "Run `codex login` in a terminal.";
    }
    return info;
  },

  /**
   * The catalogue comes from `model/list`. The default is what the user's Codex config
   * names, because that is what a task runs on when --model is left out.
   * @returns {Promise<import("./index.mjs").ModelList>}
   */
  async listModels({ cwd }) {
    const client = new StdioRpcClient({ command: "codex", args: ["app-server"], cwd }).start();
    try {
      await handshake(client);
      const models = [];
      let catalogueDefault = null;
      let cursor = null;
      do {
        const page = await client.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        for (const model of page?.data ?? []) {
          const efforts = (model.supportedReasoningEfforts ?? [])
            .map((option) => option.reasoningEffort)
            .filter((effort) => effort && effort !== "none");
          models.push({ id: model.model ?? model.id, name: model.displayName ?? "", efforts });
          if (model.isDefault) catalogueDefault = model.model ?? model.id;
        }
        cursor = page?.nextCursor ?? null;
      } while (cursor);

      let configured = {};
      try {
        const response = await client.request("config/read", {});
        configured = response?.config ?? {};
      } catch {
        // Older servers may not have config/read; fall back to the catalogue default.
      }
      return {
        models,
        defaultModel: configured.model ?? catalogueDefault,
        defaultEffort: configured.model_reasoning_effort ?? null,
        note: configured.model_provider ? `Provider from your Codex config: ${configured.model_provider}.` : null
      };
    } finally {
      await client.close();
    }
  },

  /**
   * @param {import("./index.mjs").RunOptions} options
   * @returns {Promise<import("./index.mjs").RunResult>}
   */
  async run({ cwd, prompt, permissionMode, model, effort, resumeSessionId, signal, onEvent, askUser }) {
    const policy = POLICY[permissionMode];
    if (!policy) throw new Error(`Codex has no settings for permission mode "${permissionMode}".`);
    const client = new StdioRpcClient({ command: "codex", args: ["app-server"], cwd }).start();
    const actions = [];
    const messages = [];
    const finishedTurns = new Map();
    // File changes that have started and not finished: an approval request names the
    // item, and the item is what lists the files.
    const pendingFileChanges = new Map();
    let notifyTurnFinished = () => {};
    let usage = null;
    let lastError = null;
    let threadId = null;
    let turnId = null;
    let cancelled = false;
    let stopGrace = () => {};

    // Codex can start agents of its own. Each works in a thread of its own and reports
    // on this same connection. What they do is shown as progress under their name, and
    // the turn is not over while one of them is still at work.
    const subagentNames = new Map();
    const busySubagents = new Set();
    const openCollaborations = new Set();
    let unnamedSubagents = 0;
    const nameSubagent = (id, thread = {}) => {
      const name = thread.name ?? thread.agentNickname ?? thread.agentRole;
      if (id && name) subagentNames.set(id, name);
    };
    // One that Codex gave no name gets a number the first time it is mentioned.
    const subagentName = (id) => {
      if (!subagentNames.has(id)) subagentNames.set(id, `agent ${(unnamedSubagents += 1)}`);
      return subagentNames.get(id);
    };

    let finalAnswerSeen = false;
    let inferTimer = null;
    let finishByInference = () => {};
    const considerInferredFinish = () => {
      clearTimeout(inferTimer);
      if (!finalAnswerSeen || openCollaborations.size || busySubagents.size) return;
      inferTimer = setTimeout(() => {
        if (openCollaborations.size || busySubagents.size || finishedTurns.has(turnId)) return;
        onEvent({ type: "note", text: "Codex gave its final answer but did not report the turn as finished; taking it as finished" });
        finishByInference();
      }, INFERRED_FINISH_MS);
      inferTimer.unref();
    };

    const onSubagentEvent = (method, params) => {
      const who = `subagent ${subagentName(params.threadId)}`;
      switch (method) {
        case "turn/started":
          busySubagents.add(params.threadId);
          return;
        case "turn/completed":
          busySubagents.delete(params.threadId);
          considerInferredFinish();
          return;
        case "item/completed": {
          const item = params?.item ?? {};
          if (item.type === "agentMessage" && item.text) {
            onEvent({ type: "progress", text: `${who}: ${clipHead(item.text, 600)}` });
          } else if (item.type === "commandExecution") {
            onEvent({ type: "progress", text: `${who} ran: ${oneLine(item.command)} (exit ${item.exitCode ?? "?"})` });
          }
          return;
        }
        default:
      }
    };

    client.onNotification = (method, params) => {
      if (method === "thread/started") return nameSubagent(params?.thread?.id, params?.thread);
      if (method === "thread/name/updated") return nameSubagent(params?.threadId, { name: params?.threadName });
      if (threadId && params?.threadId && params.threadId !== threadId) return onSubagentEvent(method, params);
      switch (method) {
        case "item/started": {
          const item = params?.item ?? {};
          if (item.type === "fileChange" && item.id) pendingFileChanges.set(item.id, item);
          if (item.type === "commandExecution") {
            onEvent({ type: "progress", text: `running command: ${oneLine(item.command)}` });
          }
          if (item.type === "collabAgentToolCall") {
            openCollaborations.add(item.id);
            const names = (item.receiverThreadIds ?? []).map(subagentName).join(", ");
            onEvent({ type: "progress", text: `starting subagent: ${names || item.tool || "collaboration"}` });
          }
          return;
        }
        case "item/completed": {
          const item = params?.item ?? {};
          pendingFileChanges.delete(item.id);
          if (item.type === "collabAgentToolCall") {
            openCollaborations.delete(item.id);
            considerInferredFinish();
          }
          if (item.type === "agentMessage" && item.text) {
            messages.push({ text: item.text, phase: item.phase ?? null });
            // The final answer is delivered as the result; only interim messages are progress.
            if (item.phase !== "final_answer") onEvent({ type: "progress", text: `message: ${clipHead(item.text)}` });
            else {
              finalAnswerSeen = true;
              considerInferredFinish();
            }
            return;
          }
          if (item.type === "reasoning") {
            const summary = (item.summary ?? []).join("\n").trim();
            if (summary) onEvent({ type: "progress", text: `thinking: ${clipHead(summary, 1200)}` });
            return;
          }
          const action = toAction(item);
          if (action) {
            actions.push(action);
            const output = item.type === "commandExecution" ? clipTail(item.aggregatedOutput) : "";
            onEvent({ type: "action", action, output });
          }
          return;
        }
        case "thread/tokenUsage/updated":
          usage = params?.tokenUsage?.total ?? usage;
          return;
        case "error":
          lastError = params?.error?.message ?? lastError;
          onEvent({ type: "note", text: `error: ${lastError}${params?.willRetry ? " (retrying)" : ""}` });
          return;
        case "turn/completed":
          if (params?.turn?.id) {
            finishedTurns.set(params.turn.id, params.turn);
            notifyTurnFinished();
          }
          return;
        default:
      }
    };

    client.onRequest = async (method, params) => {
      const forCommand = method === "item/commandExecution/requestApproval";
      const forFiles = method === "item/fileChange/requestApproval";
      if (forCommand || forFiles) {
        const request = forCommand
          ? describeCommand(params)
          : describeFileChange(params, pendingFileChanges.get(params?.itemId));
        const mayAsk = policy.whenAsked === "user" && !(forFiles && policy.refuseEdits);
        const answer = mayAsk ? await askUser(request) : { decision: "deny", message: null };
        const allowed = answer.decision === "allow";
        // The user's reply goes in as a message to the running turn, after the refusal.
        if (!allowed && answer.message) setTimeout(() => passOn(request, answer.message), 0);
        // "decline" refuses this one step. Codex records it as declined and carries on.
        return { decision: allowed ? "accept" : "decline" };
      }
      if (method.endsWith("/requestApproval")) {
        // A kind of approval this client does not know how to put to the user.
        const action = { kind: "approval", title: params?.reason ?? method, status: "declined" };
        actions.push(action);
        onEvent({ type: "action", action });
        return { decision: "decline" };
      }
      return refuseUnknownRequest(onEvent, method, params);
    };

    // Tell the running turn what the user said when they refused something. If the turn
    // will not take it (it may just have ended), the reply is kept and sent as a turn of
    // its own once this one is over.
    const undelivered = [];
    const steers = [];
    const passOn = (request, message) => {
      if (cancelled) return;
      const reply = refusalReply(request, message);
      steers.push(
        client
          .request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: reply, text_elements: [] }] })
          .then(
            () => onEvent({ type: "note", text: "passed the user's reply on to Codex" }),
            () => undelivered.push(reply)
          )
      );
    };

    const interrupt = () => {
      cancelled = true;
      if (threadId && turnId) {
        client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      }
    };
    signal?.addEventListener("abort", interrupt, { once: true });

    try {
      await handshake(client);

      const threadParams = {
        cwd,
        sandbox: policy.sandbox,
        approvalPolicy: policy.approvalPolicy,
        // Always sent, so that a conversation resumed after an "auto" turn does not keep
        // sending its questions to the automatic reviewer.
        approvalsReviewer: policy.approvalsReviewer,
        ...(model ? { model } : {})
      };
      const opened = resumeSessionId
        ? await client.request("thread/resume", { threadId: resumeSessionId, excludeTurns: true, ...threadParams })
        : await client.request("thread/start", { ephemeral: false, ...threadParams });
      threadId = opened?.thread?.id ?? resumeSessionId;
      const usedModel = opened?.model ?? opened?.thread?.model ?? model ?? null;
      onEvent({ type: "session", sessionId: threadId, model: usedModel });

      if (signal?.aborted) {
        return { status: "cancelled", sessionId: threadId, model: usedModel, text: "", actions, usage, error: null };
      }

      const runTurn = async (text) => {
        finalAnswerSeen = false;
        clearTimeout(inferTimer);
        const started = await client.request("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          sandboxPolicy: SANDBOX_POLICY[policy.sandbox],
          ...(effort ? { effort } : {})
        });
        turnId = started?.turn?.id;
        if (cancelled) interrupt(); // Abort arrived before the turn id was known.

        return new Promise((resolve, reject) => {
          const settle = () => {
            if (finishedTurns.has(turnId)) resolve(finishedTurns.get(turnId));
          };
          finishByInference = () => resolve({ status: "completed", error: null });
          notifyTurnFinished = settle;
          settle();
          client.failure.catch(reject);
          // If an interrupt is never acknowledged, stop waiting. The abort may already have
          // happened by now (while turn/start was in flight), which afterAbort allows for.
          stopGrace();
          stopGrace = afterAbort(signal, CANCEL_GRACE_MS, () => resolve({ status: "interrupted", error: null }));
        });
      };

      let turn = await runTurn(prompt);
      for (;;) {
        await Promise.all(steers.splice(0)); // Know whether each reply got through.
        if (!undelivered.length || cancelled || turn.status !== "completed") break;
        onEvent({ type: "note", text: "the turn ended before the user's reply reached Codex; sending it as a follow-up" });
        turn = await runTurn(undelivered.splice(0).join("\n\n"));
      }

      const finals = messages.filter((m) => m.phase === "final_answer");
      const text = finals.length
        ? finals.map((m) => m.text).join("\n\n")
        : messages.length
          ? messages[messages.length - 1].text
          : "";

      let status = "failed";
      if (cancelled || turn.status === "interrupted") status = "cancelled";
      else if (turn.status === "completed") status = "completed";

      return {
        status,
        sessionId: threadId,
        model: usedModel,
        text,
        actions,
        usage: toUsage(usage),
        error: status === "failed" ? turn.error?.message ?? lastError ?? "Codex reported a failed turn." : null
      };
    } finally {
      stopGrace();
      clearTimeout(inferTimer);
      signal?.removeEventListener("abort", interrupt);
      await client.close();
    }
  }
};
