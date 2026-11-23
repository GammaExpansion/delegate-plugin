// Codex backend: drives `codex app-server` (stdio JSON-RPC).
//
// Permissions: a turn runs under one of Codex's own permission options (see PERMISSIONS),
// which sets its sandbox and when it asks for approval. A request that reaches this client
// goes to `onApproval` with Codex's own answers to choose from (DECISIONS); without it, or
// without a choice, it is declined. Codex records a declined step as declined and carries
// on, which is how it ends up in the result.
import { execCommandSync } from "../command.mjs";
import { afterAbort, CANCEL_GRACE_MS } from "../abort.mjs";
import { StdioRpcClient } from "../rpc.mjs";
import { clipHead, clipTail, oneLine } from "../text.mjs";
import { CLIENT_INFO, pickPermission, pickSandbox, refuseUnknownRequest, toUsage } from "./shared.mjs";

// Token-level deltas are skipped: progress is reported per finished item
// (a message, a reasoning summary, a command with its output), which is enough to follow along.
const QUIET_NOTIFICATIONS = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta"
];

// Codex's own permission options, under the names of its /permissions menu, and the
// settings each one stands for. Nothing is translated: a caller names one of these.
//   - read-only        -> "Read Only": a sandbox that cannot write and has no network.
//                         Commands that only read still run. It asks before anything more.
//   - ask-for-approval -> "Ask for approval": a sandbox that can write to the workspace
//                         and temp directories, no network. It asks before stepping outside.
//   - approve-for-me   -> "Approve for me" (`codex --approve-for-me`): the same sandbox,
//                         but Codex's own automatic reviewer answers its requests.
//   - full-access      -> "Full Access": no sandbox, network included, nothing asked.
const PERMISSIONS = {
  "read-only": { sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" },
  "ask-for-approval": { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "user" },
  "approve-for-me": { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
  "full-access": { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" }
};

/**
 * The settings for a turn. `--sandbox` overrides the sandbox an option comes with:
 * "disabled" takes it away, and "enabled" gives "full-access" the workspace sandbox, so
 * that Codex asks nothing and still cannot leave the workspace.
 */
function settingsFor({ permission, sandbox }) {
  const name = pickPermission(codexBackend, permission);
  const choice = pickSandbox(sandbox);
  const settings = { ...PERMISSIONS[name] };
  if (choice === "disabled") {
    if (name === "read-only") throw new Error('Codex\'s "read-only" is its sandbox, so it cannot run with --sandbox disabled. Pick another --permission.');
    settings.sandbox = "danger-full-access";
  } else if (choice === "enabled" && name === "full-access") {
    settings.sandbox = "workspace-write";
  }
  return { permission: name, sandbox: choice, settings };
}

// Codex normally says when a turn is over. If its final answer has arrived, none of its
// own agents is still at work, and that word has not come after this long, the turn is
// taken as finished. Without this a lost notification would leave the turn running forever.
const INFERRED_FINISH_MS = 1500;

// The sandbox as a full policy object. It is sent with every turn, so that a resumed
// conversation takes this turn's sandbox, not that of its last turn, and so that the
// user's own Codex config cannot widen or narrow what an option means.
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

/**
 * Codex's own answers to a request for approval, as the user is offered them, in the
 * words of Codex's own approval prompt where it has them: the declining ones first.
 * Codex keeps "acceptForSession" as long as its app-server, which here is the one task it
 * was started for. Codex's persistent rules (an exec policy or network policy amendment)
 * are not offered.
 */
const DECISIONS = [
  { id: "decline", label: "No, continue without it", allow: false },
  { id: "accept", label: "Yes, just this once", allow: true },
  { id: "acceptForSession", label: "Yes, and don't ask again in this session", allow: true },
  { id: "cancel", label: "No, and stop Codex", allow: false, stop: true }
];
const PLAIN_DECISIONS = DECISIONS.filter((choice) => choice.id === "decline" || choice.id === "accept");

/**
 * What a request for approval is about, for whoever is asked: a command and where it runs,
 * the files an edit touches, or else the reason Codex gives; and the answers it takes.
 * @returns {import("./index.mjs").ApprovalRequest}
 */
function approvalRequest(method, params, item) {
  if (method === "item/commandExecution/requestApproval") {
    const command = params?.command ?? item?.command ?? "a command";
    const network = params?.networkApprovalContext;
    if (network?.host) {
      return {
        kind: "network",
        title: `${network.protocol ? `${network.protocol}://` : ""}${network.host} (for \`${command}\`)`,
        cwd: params?.cwd ?? item?.cwd ?? null,
        reason: params?.reason ?? null,
        choices: DECISIONS
      };
    }
    return {
      // "writeStdin": input for a command that is already running, not a new command.
      kind: params?.kind === "writeStdin" ? "input" : "command",
      title: command,
      cwd: params?.cwd ?? item?.cwd ?? null,
      reason: params?.reason ?? null,
      choices: DECISIONS
    };
  }
  if (method === "item/permissions/requestApproval") {
    return { kind: "permissions", title: describePermissions(params?.permissions), cwd: params?.cwd ?? null, reason: params?.reason ?? null, choices: PLAIN_DECISIONS };
  }
  if (method === "item/fileChange/requestApproval") {
    const changes = (item?.changes ?? []).map(describeChange);
    return {
      kind: "edit",
      title: changes.length ? changes.join(", ") : params?.reason ?? "edit files",
      cwd: null,
      reason: params?.reason ?? null,
      choices: DECISIONS
    };
  }
  return { kind: "approval", title: params?.reason ?? method, cwd: null, reason: null, choices: PLAIN_DECISIONS };
}

/** "write /a, /b; read /c; network": what a request for more permissions asks for. */
function describePermissions(permissions) {
  const fs = permissions?.fileSystem ?? {};
  const parts = [];
  const write = [...(fs.write ?? []), ...(fs.entries ?? []).filter((e) => e?.access === "write").map((e) => e?.path?.path ?? JSON.stringify(e?.path))];
  const read = [...(fs.read ?? []), ...(fs.entries ?? []).filter((e) => e?.access === "read").map((e) => e?.path?.path ?? JSON.stringify(e?.path))];
  if (write.length) parts.push(`write ${write.join(", ")}`);
  if (read.length) parts.push(`read ${read.join(", ")}`);
  if (permissions?.network?.enabled) parts.push("network access");
  return parts.length ? parts.join("; ") : JSON.stringify(permissions ?? {});
}

/** What the user wrote in place of picking an answer, or null. */
const wordsOf = (answer) =>
  answer && typeof answer === "object" && typeof answer.text === "string" && answer.text.trim() ? answer.text.trim() : null;

/** How the user's own words reach Codex, with what they are about. */
const relayWords = (request, words) =>
  `About your request to ${request.kind === "command" ? `run \`${request.title}\`` : `${request.kind}: ${request.title}`}: the user did not allow it, and wrote:\n\n${words}`;

/** The answer picked, by its id; with none, the first that declines. */
function pickChoice(choices, answer) {
  if (typeof answer === "string") {
    const picked = choices.find((choice) => choice.id === answer);
    if (picked) return picked;
  }
  return choices.find((choice) => !choice.allow);
}

/**
 * Whether Codex needs an OpenAI login for the model provider it is set up with, as its
 * app-server tells it; null when that could not be learned. Nothing is read from the
 * user's Codex config here: Codex reads it.
 */
async function needsOpenaiLogin() {
  const client = new StdioRpcClient({ command: "codex", args: ["app-server"], cwd: process.cwd() }).start();
  try {
    const asked = (async () => {
      await handshake(client);
      try {
        return await client.request("account/read", { refreshToken: false });
      } catch {
        return client.request("getAuthStatus", { includeToken: false, refreshToken: false });
      }
    })();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 15_000).unref());
    const status = await Promise.race([asked, timeout, client.failure]);
    return typeof status?.requiresOpenaiAuth === "boolean" ? status.requiresOpenaiAuth : null;
  } catch {
    return null;
  } finally {
    await client.close();
  }
}

export const codexBackend = {
  name: "codex",
  label: "Codex",
  agentName: "Codex Agent",
  permissions: PERMISSIONS,
  defaultPermission: "read-only",
  settingsFor,

  async check() {
    const info = { installed: false, version: null, auth: "unknown", hint: null };
    try {
      info.version = execCommandSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      info.installed = true;
    } catch {
      info.hint = "Install with `npm install -g @openai/codex`.";
      return info;
    }
    try {
      // Exit code only: the output can include part of an API key, so it is not echoed.
      execCommandSync("codex", ["login", "status"], { stdio: "ignore" });
      info.auth = "ok";
      return info;
    } catch {
      // Not signed in to OpenAI. That is fine for a model provider of the user's own (an
      // API gateway, a local model), and Codex says which it is.
    }
    if ((await needsOpenaiLogin()) === false) {
      info.auth = "provider";
    } else {
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
  async run({ cwd, prompt, permission, sandbox, model, effort, resumeSessionId, signal, traceFile, onEvent, onApproval }) {
    const { settings: policy } = settingsFor({ permission, sandbox });
    const client = new StdioRpcClient({ command: "codex", args: ["app-server"], cwd, traceFile }).start();
    const actions = [];
    const messages = [];
    // Items as they started, so that a request for approval can say what it is about.
    const startedItems = new Map();
    const finishedTurns = new Map();
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
      // Kept from every thread, so that a request from one of Codex's own agents can say what it is about.
      if (method === "item/started" && params?.item?.id) startedItems.set(params.item.id, params.item);
      if (threadId && params?.threadId && params.threadId !== threadId) return onSubagentEvent(method, params);
      switch (method) {
        case "item/started": {
          const item = params?.item ?? {};
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
      if (!method.endsWith("/requestApproval")) return refuseUnknownRequest(onEvent, method, params);
      const request = approvalRequest(method, params, startedItems.get(params?.itemId));
      const answer = onApproval && !signal?.aborted ? await onApproval(request) : null;
      const words = wordsOf(answer);
      // Words in place of an answer decline the step, and reach Codex as a message.
      const choice = words ? request.choices.find((option) => option.id === "decline") ?? pickChoice(request.choices, null) : pickChoice(request.choices, answer);
      if (words) setTimeout(() => steer(relayWords(request, words)), 0); // after the decision has gone out
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        // Codex reports the step itself, as declined when it was (see item/completed
        // above), and carries on with the turn, or stops it after "cancel".
        return { decision: choice.id };
      }
      if (method === "item/permissions/requestApproval") {
        // An answer grants what was asked for, for this turn, or nothing.
        if (!choice.allow) {
          const action = { kind: "permissions", title: request.title, status: "declined" };
          actions.push(action);
          onEvent({ type: "action", action });
        }
        return { permissions: choice.allow ? params?.permissions ?? {} : {}, scope: "turn" };
      }
      // A kind of approval that comes with no step of its own to report it.
      if (!choice.allow) {
        const action = { kind: "approval", title: request.title, status: "declined" };
        actions.push(action);
        onEvent({ type: "action", action });
      }
      return { decision: choice.id };
    };

    // The user's words go into the running turn (turn/steer). If the turn has ended by
    // then, they open the next one, which this run waits for as well.
    const followUps = [];
    const steer = (text) => {
      if (cancelled) return;
      onEvent({ type: "note", text: "passing the user's words on to Codex" });
      client
        .request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text, text_elements: [] }] })
        .catch(() => followUps.push(text));
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
        // Always sent, so that a conversation resumed after an "approve-for-me" turn does
        // not keep sending its questions to the automatic reviewer.
        approvalsReviewer: policy.approvalsReviewer,
        ...(model ? { model } : {})
      };
      const notes = [];
      let opened = null;
      if (resumeSessionId) {
        try {
          opened = await client.request("thread/resume", { threadId: resumeSessionId, excludeTurns: true, ...threadParams });
        } catch (error) {
          // A conversation whose session is gone (its rollout deleted, another CODEX_HOME)
          // goes on in a new one rather than failing every turn from here on.
          notes.push(`the earlier Codex session could not be resumed (${error?.message ?? error}), so this turn started a new one, which knows nothing of the earlier conversation`);
          resumeSessionId = undefined;
        }
      }
      opened ??= await client.request("thread/start", { ephemeral: false, ...threadParams });
      threadId = opened?.thread?.id ?? resumeSessionId;
      const usedModel = opened?.model ?? opened?.thread?.model ?? model ?? null;
      // The effort this turn runs at: the one asked for, or the one Codex opened the thread with.
      const usedEffort = effort ?? opened?.reasoningEffort ?? opened?.thread?.reasoningEffort ?? null;
      onEvent({ type: "session", sessionId: threadId, model: usedModel, effort: usedEffort });

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
      // Words that came too late to steer the turn they were about.
      for (let more = 0; more < 3 && followUps.length && !cancelled && turn.status === "completed"; more += 1) {
        turn = await runTurn(followUps.splice(0).join("\n\n"));
      }

      let status = "failed";
      if (cancelled || turn.status === "interrupted") status = "cancelled";
      else if (turn.status === "completed") status = "completed";

      // The answer is Codex's final answer. Only a turn that ran its course without
      // marking one takes its last message instead: a stopped turn's last message is
      // something Codex said on the way, not an answer.
      const finals = messages.filter((m) => m.phase === "final_answer");
      const text = finals.length
        ? finals.map((m) => m.text).join("\n\n")
        : messages.length && status !== "cancelled"
          ? messages[messages.length - 1].text
          : "";

      return {
        status,
        sessionId: threadId,
        model: usedModel,
        text,
        actions,
        usage: toUsage(usage),
        error: status === "failed" ? turn.error?.message ?? lastError ?? "Codex reported a failed turn." : null,
        notes
      };
    } finally {
      stopGrace();
      clearTimeout(inferTimer);
      signal?.removeEventListener("abort", interrupt);
      await client.close();
    }
  }
};
