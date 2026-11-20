// Antigravity backend: drives `agy acp` (Agent Client Protocol over stdio).
//
// Permissions: two things decide what agy may do, both chosen from the task's
// permission mode (see POLICY):
//   - its session mode, which decides what it does without asking
//   - what happens when it does ask (`session/request_permission`): the user answers,
//     or the request is refused, or (with no limits at all) it is never asked
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAbort, CANCEL_GRACE_MS } from "../abort.mjs";
import { StdioRpcClient } from "../rpc.mjs";
import { clipHead, clipTail, oneLine } from "../text.mjs";
import { CLIENT_INFO, addUsage, refusalReply, refuseUnknownRequest, toUsage } from "./shared.mjs";

const READ_KINDS = new Set(["read", "search", "think"]);
const EDIT_KINDS = new Set(["edit", "delete", "move"]);

// Claude Code permission mode -> how agy is started, its session mode, and what happens
// when it asks. Each mode uses agy's own counterpart where it has one.
//   - "plan": agy's plan mode. It researches and writes a plan into its own data
//     directory, not into the workspace. Edits it asks about are refused; anything else
//     it asks about goes to the user.
//   - "default": agy's default mode, which asks before every edit and command. The user
//     answers.
//   - "dontAsk": the same mode, but every request is refused. That is what the mode means.
//   - "acceptEdits": agy's accept-edits mode edits files in the workspace without asking.
//     Commands, and edits outside the workspace, go to the user.
//   - "auto": agy's auto mode runs edits and commands inside its own sandbox without
//     asking. What it still asks about goes to the user.
//   - "bypassPermissions": agy is started with --dangerously-skip-permissions (what its
//     desktop app calls Turbo), so it does not ask at all. Should it ask anyway, the
//     answer is yes.
// Reading and searching inside the workspace is always allowed, and agy rarely asks for
// it. A read outside the workspace is a request like any other, and so is one that does
// not say where: agy asks about a read when it thinks the read leaves the workspace.
const POLICY = {
  plan: { mode: "plan", whenAsked: "user", refuse: EDIT_KINDS },
  default: { mode: "default", whenAsked: "user" },
  dontAsk: { mode: "default", whenAsked: "refuse" },
  acceptEdits: { mode: "accept-edits", whenAsked: "user" },
  auto: { mode: "auto", whenAsked: "user" },
  bypassPermissions: { mode: "default", whenAsked: "allow", args: ["--dangerously-skip-permissions"] }
};

const SUMMARY = {
  execute: "run a command",
  edit: "edit a file",
  delete: "delete a file",
  move: "move a file",
  read: "read a file outside the workspace",
  search: "search outside the workspace",
  fetch: "fetch from the web"
};

/**
 * Whether `target` lies inside `root`, going by where it really is: `..` cannot step out
 * and neither can a symbolic link. A path that does not exist yet is taken as written.
 */
function isInside(root, target) {
  let real = path.resolve(root, target);
  try {
    real = fs.realpathSync(real);
  } catch {
    // Not there (yet): nothing to follow.
  }
  const relative = path.relative(root, real);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
const FINISHED = new Set(["completed", "failed"]);
const FLUSH_INTERVAL_MS = 4000;

/** Text a finished tool call reported, if any (ACP puts it in `content`). */
function toolOutputText(update) {
  const parts = [];
  for (const entry of update.content ?? []) {
    const inner = entry?.content ?? entry;
    if (inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text);
  }
  // agy prefixes command results with timestamps that say nothing about the outcome.
  return parts
    .join("\n")
    .split("\n")
    .filter((line) => !/^(Created At|Completed At):/.test(line))
    .join("\n");
}

/** Runs `agy models`, which prints one "id<TAB>name" line per model. Throws if it cannot. */
function fetchModels() {
  let output;
  try {
    output = execFileSync("agy", ["models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("`agy` was not found on PATH.");
    const lastLine = String(error.stderr || error.message).trim().split("\n").pop();
    throw new Error(`\`agy models\` failed: ${lastLine}`);
  }
  const models = output
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && parts[0].trim())
    .map(([id, name]) => ({ id: id.trim(), name: name.trim(), efforts: [] }));
  if (!models.length) throw new Error("`agy models` listed no models.");
  return models;
}

function pickOption(options, allow) {
  const exact = allow ? "allow_once" : "reject_once";
  const prefix = allow ? "allow" : "reject";
  return (
    options.find((option) => option.kind === exact) ??
    options.find((option) => typeof option.kind === "string" && option.kind.startsWith(prefix)) ??
    null
  );
}

export const agyBackend = {
  name: "agy",
  label: "Antigravity",

  check() {
    const info = { installed: false, version: null, auth: "unknown", hint: null };
    try {
      info.version = execFileSync("agy", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      info.installed = true;
    } catch {
      info.hint = "Install the Antigravity CLI so that `agy` is on PATH.";
      return info;
    }
    // agy has no "am I logged in" command. Fetching the model list needs the account,
    // so a successful fetch is taken as proof of a working login.
    try {
      fetchModels();
      info.auth = "ok";
    } catch (error) {
      info.hint = `Could not confirm the login (${error.message}) If tasks fail, run \`agy\` once in a terminal and sign in.`;
    }
    return info;
  },

  /**
   * `agy models` prints one "id<TAB>name" line per model. It does not say which one is
   * the default; that is only known once a session opens.
   * @returns {Promise<import("./index.mjs").ModelList>}
   */
  async listModels() {
    return {
      models: fetchModels(),
      defaultModel: null,
      defaultEffort: null,
      note: "Each id already includes a thinking level. agy does not report its default model here; every task result names the model it ran on."
    };
  },

  /**
   * @param {import("./index.mjs").RunOptions} options
   * @returns {Promise<import("./index.mjs").RunResult>}
   */
  async run({ cwd, prompt, permissionMode, model, effort, resumeSessionId, signal, onEvent, askUser }) {
    const policy = POLICY[permissionMode];
    if (!policy) throw new Error(`agy has no settings for permission mode "${permissionMode}".`);
    const client = new StdioRpcClient({
      command: "agy",
      args: ["acp", ...(policy.args ?? [])],
      cwd,
      includeJsonRpcField: true
    }).start();
    const tools = new Map();
    let text = "";
    let sessionId = null;
    let replaying = false;
    let cancelled = false;
    let stopGrace = () => {};
    // What the user said when refusing something. agy takes no message with a refusal, and
    // a refusal usually ends its turn, so these are sent as the next message once it stops.
    const replies = [];
    // agy speaks in several stretches, with thinking and tool calls in between. They are
    // kept apart in the final message, or one stretch would run straight into the next.
    let messageBroken = false;

    const actionsList = () => [...tools.values()];

    // agy streams text in small chunks. Progress is reported in readable pieces:
    // a buffer is flushed when a tool call starts, when the stream switches between
    // thinking and answering, and every few seconds.
    const pending = { message: "", thinking: "" };
    const flush = (kind) => {
      const value = pending[kind].trim();
      pending[kind] = "";
      if (value) onEvent({ type: "progress", text: `${kind}: ${clipHead(value)}` });
    };
    const flushTimer = setInterval(() => {
      flush("thinking");
      flush("message");
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref();

    client.onNotification = (method, params) => {
      // `session/load` replays the whole history as updates before it returns; skip those.
      if (method !== "session/update" || replaying) return;
      const update = params?.update ?? {};
      switch (update.sessionUpdate) {
        case "agent_message_chunk":
          // After a cancel agy emits a "stream was interrupted, please continue" line.
          // It is not part of the answer and must not reach the caller.
          if (cancelled || update.content?.type !== "text") return;
          flush("thinking");
          let chunk = update.content.text;
          if (messageBroken && text.trim()) {
            // A new stretch: exactly one blank line between it and the one before.
            chunk = chunk.replace(/^\s+/, "");
            if (!chunk) return;
            text = `${text.trimEnd()}\n\n`;
          }
          messageBroken = false;
          text += chunk;
          pending.message += chunk;
          return;
        case "agent_thought_chunk":
          if (cancelled || update.content?.type !== "text") return;
          flush("message");
          messageBroken = true;
          pending.thinking += update.content.text;
          return;
        case "tool_call":
        case "tool_call_update": {
          const known = tools.has(update.toolCallId);
          const previous = tools.get(update.toolCallId) ?? {};
          const action = {
            ...previous,
            kind: update.kind ?? previous.kind ?? "tool",
            title: update.title ?? update.name ?? previous.title ?? "tool call",
            status: update.status ?? previous.status
          };
          tools.set(update.toolCallId, action);
          if (!known) {
            flush("thinking");
            flush("message");
            messageBroken = true;
            onEvent({ type: "progress", text: `starting ${action.kind}: ${oneLine(action.title)}` });
          }
          if (FINISHED.has(action.status) && previous.status !== action.status) {
            onEvent({ type: "action", action, output: clipTail(toolOutputText(update)) });
          }
          return;
        }
        default:
      }
    };

    let workspace = cwd;
    try {
      workspace = fs.realpathSync(cwd);
    } catch {
      // Keep the path as given.
    }

    client.onRequest = async (method, params) => {
      if (method !== "session/request_permission") return refuseUnknownRequest(onEvent, method, params);
      const call = params?.toolCall ?? {};
      onEvent({
        type: "note",
        text: `permission request: ${call.kind ?? "?"} ${oneLine(call.title ?? call.name ?? "", 120)} options=${oneLine(JSON.stringify((params?.options ?? []).map((o) => `${o.kind}:${o.name}`)), 200)}`
      });
      const entry = tools.get(call.toolCallId) ?? { kind: call.kind ?? "tool", title: call.title ?? call.name ?? "tool call" };
      const paths = (call.locations ?? []).map((location) => location?.path).filter(Boolean);
      // "think" touches nothing. Any other read counts as inside only if it names its
      // paths and every one of them really is inside.
      const harmless =
        call.kind === "think" ||
        (READ_KINDS.has(call.kind) && paths.length > 0 && paths.every((target) => isInside(workspace, target)));

      let allow;
      if (policy.whenAsked === "allow") allow = true;
      else if (harmless) allow = true;
      else if (policy.whenAsked === "refuse" || policy.refuse?.has(call.kind)) allow = false;
      else {
        const detail = [entry.title, ...paths.filter((target) => !String(entry.title).includes(target))].join("\n");
        // agy can make several requests of one kind, so the reply names which one it answers.
        const request = { summary: `${SUMMARY[call.kind] ?? `use a tool (${call.kind ?? "unnamed"})`}`, detail };
        const answer = await askUser(request);
        allow = answer.decision === "allow";
        if (!allow && answer.message) {
          replies.push(refusalReply({ summary: `${request.summary} (${oneLine(entry.title, 160)})` }, answer.message));
        }
      }

      const option = pickOption(params?.options ?? [], allow);
      tools.set(call.toolCallId, { ...(tools.get(call.toolCallId) ?? entry), permission: allow && option ? "allowed" : "denied" });
      if (!allow) onEvent({ type: "note", text: `denied (permission mode ${permissionMode}): ${entry.kind} ${entry.title}` });
      if (!option) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: option.optionId } };
    };

    const cancel = () => {
      cancelled = true;
      if (sessionId) client.notify("session/cancel", { sessionId });
    };
    signal?.addEventListener("abort", cancel, { once: true });

    try {
      await client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO
      });

      let opened;
      if (resumeSessionId) {
        replaying = true;
        try {
          opened = await client.request("session/load", { sessionId: resumeSessionId, cwd, mcpServers: [] });
        } finally {
          replaying = false;
        }
        sessionId = opened?.sessionId ?? resumeSessionId;
      } else {
        opened = await client.request("session/new", { cwd, mcpServers: [] });
        sessionId = opened.sessionId;
      }

      let usedModel = opened?.models?.currentModelId ?? null;
      if (model) {
        try {
          await client.request("session/set_model", { sessionId, modelId: model });
          usedModel = model;
        } catch (error) {
          const available = (opened?.models?.availableModels ?? []).map((m) => m.modelId).join(", ");
          throw new Error(`agy rejected model "${model}": ${error.message}${available ? `\nAvailable: ${available}` : ""}`);
        }
      }
      // Set on every turn: a resumed session would otherwise keep the mode of its last turn.
      // If agy refuses the mode, the turn fails, because the mode is part of the permission.
      await client.request("session/set_mode", { sessionId, modeId: policy.mode });
      if (effort) {
        try {
          await client.request("session/set_config_option", { sessionId, configId: "thought_level", value: effort });
        } catch (error) {
          onEvent({ type: "note", text: `could not set effort "${effort}": ${error.message}` });
        }
      }
      onEvent({ type: "session", sessionId, model: usedModel });

      if (signal?.aborted) {
        return { status: "cancelled", sessionId, model: usedModel, text: "", actions: actionsList(), usage: null, error: null };
      }

      // If agy never answers a cancel, stop waiting. Closing the client below ends agy.
      const gaveUp = new Promise((resolve) => {
        stopGrace = afterAbort(signal, CANCEL_GRACE_MS, () => resolve({ stopReason: "cancelled" }));
      });
      // agy reports token counts per message, so a job that sends several adds them up.
      let usage = null;
      const send = async (message) => {
        const outcome = await Promise.race([
          client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: message }] }),
          client.failure,
          gaveUp
        ]);
        usage = addUsage(usage, toUsage(outcome?.usage));
        return outcome;
      };

      let result = await send(prompt);
      // Each reply the user gave with a refusal becomes one more message in the same turn
      // of the job, so that agy can act on it instead of stopping at the refusal.
      while (replies.length && !cancelled && result?.stopReason === "end_turn") {
        const reply = replies.splice(0).join("\n\n");
        onEvent({ type: "note", text: "passing the user's reply on to agy" });
        messageBroken = true;
        result = await send(reply);
      }

      const stop = result?.stopReason;
      let status = "completed";
      let error = null;
      if (cancelled || stop === "cancelled") {
        status = "cancelled";
      } else if (stop !== "end_turn") {
        status = "failed";
        error = `agy stopped early (stopReason: ${stop ?? "unknown"}).`;
      }

      return { status, sessionId, model: usedModel, text: text.trim(), actions: actionsList(), usage, error };
    } finally {
      stopGrace();
      clearInterval(flushTimer);
      flush("thinking"); // Leftover answer text is not flushed: it is returned as the result.
      signal?.removeEventListener("abort", cancel);
      await client.close();
    }
  }
};
