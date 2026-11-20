// Antigravity backend: drives `agy acp` (Agent Client Protocol over stdio).
//
// Permissions: a turn runs under one of agy's own permission options (see PERMISSIONS),
// which is a session mode or the flag that switches its checks off. Nobody is there to
// approve anything while a delegate runs, so what agy asks about is declined and listed
// in the result. The one exception is reading inside the workspace, which is allowed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAbort, CANCEL_GRACE_MS } from "../abort.mjs";
import { StdioRpcClient } from "../rpc.mjs";
import { clipHead, clipTail, oneLine } from "../text.mjs";
import { CLIENT_INFO, addUsage, pickPermission, pickSandbox, refuseUnknownRequest, toUsage } from "./shared.mjs";

const READ_KINDS = new Set(["read", "search", "think"]);

// agy's own permission options, and what each one stands for. Nothing is translated: a
// caller names one of these. The first four are its session modes (`agy --mode`).
//   - plan             -> it researches and writes a plan into its own data directory,
//                         not into the workspace. It asks before edits and commands.
//   - default          -> it asks before every edit and every command.
//   - accept-edits     -> it edits files in the workspace without asking, and asks before
//                         commands and before touching anything outside the workspace.
//   - auto             -> it edits and runs commands without asking, and asks only about
//                         what it judges risky.
//   - skip-permissions -> `agy --dangerously-skip-permissions` (Turbo in its desktop app):
//                         its permission checks are off, so it does not ask at all.
//                         Should it ask anyway, the answer is yes.
// `--sandbox enabled` adds agy's own `--sandbox` flag, which restricts its terminal.
const PERMISSIONS = {
  plan: { mode: "plan" },
  default: { mode: "default" },
  "accept-edits": { mode: "accept-edits" },
  auto: { mode: "auto" },
  "skip-permissions": { mode: "default", args: ["--dangerously-skip-permissions"], allowAll: true }
};

function settingsFor({ permission, sandbox }) {
  const name = pickPermission(agyBackend, permission);
  const choice = pickSandbox(sandbox);
  const option = PERMISSIONS[name];
  return {
    permission: name,
    sandbox: choice,
    settings: { ...option, args: [...(option.args ?? []), ...(choice === "enabled" ? ["--sandbox"] : [])] }
  };
}

// agy tends to end its turn at a declined request without saying anything. It is then
// told, at most this many times, that nobody can approve and asked to finish without.
const MAX_NUDGES = 2;

/** What agy is told after requests of its were declined and it stopped without a word. */
function nudgeAfterDeclines(declined) {
  return [
    "These requests were declined, because nobody is there to approve requests in this run:",
    ...declined.map((entry) => `- ${entry}`),
    "Do not ask for them again. Finish what you can without them, then say plainly what you could not do and what it would have needed."
  ].join("\n");
}

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// agy runs a command that takes a while in the background: it ends its turn with the
// command still going, and carries on by itself once the command has finished, with no
// new prompt. So a turn that ends with a tool call still open is not over. It is over
// when nothing is open any more and agy has taken the model step that follows a
// command's end (which closes with a usage update) without starting anything new.
const OPEN = new Set(["pending", "in_progress"]);
const BACKGROUND_TICK_MS = 500;
// After that closing step, how long to listen for anything that still trickles in.
const BACKGROUND_SETTLE_MS = 3000;
// How long to wait for that step once the last command has ended.
const BACKGROUND_WAKE_MS = 90_000;
// The same, for a command that ended so close to the end of the turn that it cannot be
// told whether agy had taken its result in. Usually it had, so this wait is short.
const LATE_CLOSE_WAKE_MS = 20_000;

const secondsFromEnv = (name, fallback) => {
  const seconds = Number(process.env[name]);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : fallback) * 1000;
};
/** How long a background command may run without a sign of life from agy. */
const backgroundSilenceMs = () => secondsFromEnv("DELEGATE_AGY_BACKGROUND_WAIT_SEC", 30 * 60);
/** How long background work may go on in all after a turn has ended, however lively. */
const backgroundLimitMs = () => secondsFromEnv("DELEGATE_AGY_BACKGROUND_MAX_SEC", 2 * 60 * 60);

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

// agy has no separate effort setting in its model list: each thinking level of a model
// is an id of its own, such as gemini-4-neon-high. The level is the id's last part.
const LEVEL_IN_ID = /^(.+)-(minimal|low|medium|high|xhigh|max|ultra)$/;

/** Mark a model with the family it belongs to and its level, when its id carries one. */
function withFamily(model) {
  const match = model.id.match(LEVEL_IN_ID);
  if (!match) return model;
  return { ...model, family: match[1], familyName: model.name.replace(/\s*\([^)]*\)\s*$/, ""), level: match[2] };
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
    .map(([id, name]) => withFamily({ id: id.trim(), name: name.trim(), efforts: [] }));
  if (!models.length) throw new Error("`agy models` listed no models.");
  return models;
}

/**
 * The option that answers one request. An approval is only ever for this one request,
 * never a lasting one. A refusal may be any kind of "reject".
 */
function pickOption(options, allow) {
  if (allow) return options.find((option) => option.kind === "allow_once") ?? null;
  return (
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => typeof option.kind === "string" && option.kind.startsWith("reject")) ??
    null
  );
}

export const agyBackend = {
  name: "agy",
  label: "Antigravity",
  agentName: "Gemini Agent",
  permissions: PERMISSIONS,
  defaultPermission: "default",
  settingsFor,

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
      note: "agy does not say here which model it uses by default. Every task result names the model it ran on."
    };
  },

  /**
   * @param {import("./index.mjs").RunOptions} options
   * @returns {Promise<import("./index.mjs").RunResult>}
   */
  async run({ cwd, prompt, permission, sandbox, model, effort, resumeSessionId, signal, onEvent }) {
    const { permission: permissionName, settings: policy } = settingsFor({ permission, sandbox });
    const client = new StdioRpcClient({
      command: "agy",
      args: ["acp", ...policy.args],
      cwd,
      includeJsonRpcField: true
    }).start();
    const tools = new Map();
    let text = "";
    let sessionId = null;
    let replaying = false;
    let cancelled = false;
    let stopGrace = () => {};
    // Requests declined since agy last said anything. If its turn ends with some still
    // here, it stopped at the refusal without a word (see MAX_NUDGES).
    const unanswered = [];
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

    // For telling when work that agy carries on in the background is over (see settleBackground).
    let lastActivityAt = Date.now();
    let stepEndedSinceLastClose = true;

    client.onNotification = (method, params) => {
      // `session/load` replays the whole history as updates before it returns; skip those.
      if (method !== "session/update" || replaying) return;
      const update = params?.update ?? {};
      lastActivityAt = Date.now();
      switch (update.sessionUpdate) {
        case "usage_update":
          // agy reports usage at the end of each model step.
          stepEndedSinceLastClose = true;
          return;
        case "agent_message_chunk":
          // After a cancel agy emits a "stream was interrupted, please continue" line.
          // It is not part of the answer and must not reach the caller.
          if (cancelled || update.content?.type !== "text") return;
          flush("thinking");
          if (update.content.text.trim()) unanswered.length = 0;
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
          // A call that has just stopped being open, however it ended: agy has a model
          // step to take on its result, and what it says next is a new stretch of text.
          if (action.status && !OPEN.has(action.status) && action.status !== previous.status && (OPEN.has(previous.status) || !known)) {
            stepEndedSinceLastClose = false;
            messageBroken = true;
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

      const allow = Boolean(policy.allowAll || harmless);
      const option = pickOption(params?.options ?? [], allow);
      const allowed = allow && Boolean(option);
      tools.set(call.toolCallId, { ...(tools.get(call.toolCallId) ?? entry), permission: allowed ? "allowed" : "denied" });
      if (!allowed) {
        const what = `${entry.kind} ${oneLine(entry.title, 160)}`;
        unanswered.push(what);
        onEvent({ type: "note", text: `declined (permission ${permissionName}, nobody to ask): ${what}` });
      }
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
      // Set on every turn: a resumed session would otherwise keep the mode of its last turn,
      // and each turn may name a different one. If agy refuses the mode, the turn fails.
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
      let stopWaiting = false;
      gaveUp.then(() => (stopWaiting = true));
      let failure = null;
      client.failure.catch((error) => (failure = error));
      // A call that was declined is not running, whatever status agy leaves it in.
      const openTools = () => actionsList().filter((action) => OPEN.has(action.status) && action.permission !== "denied");
      const named = (actions) => actions.map((action) => oneLine(action.title, 80)).join("; ");

      /**
       * Wait out the work agy carries on with after ending its turn (see OPEN above).
       * Returns null when that work is over, or what went wrong with it.
       */
      const settleBackground = async () => {
        // A command can also end just before the turn does, with agy's step on its result
        // still to come. Not after a refusal, though: there agy has simply stopped.
        const lateClose = !stepEndedSinceLastClose && !unanswered.length;
        if (!openTools().length && !lateClose) return null;
        if (openTools().length) {
          onEvent({ type: "note", text: "agy ended its turn with a command still running; waiting for it to carry on" });
        }
        const startedAt = Date.now();
        const silenceMs = backgroundSilenceMs();
        const limitMs = backgroundLimitMs();
        let wakeMs = openTools().length ? BACKGROUND_WAKE_MS : LATE_CLOSE_WAKE_MS;
        while (!cancelled && !stopWaiting) {
          if (failure) return `agy stopped while it was still at work after ending its turn. ${failure.message}`;
          await sleep(BACKGROUND_TICK_MS);
          const now = Date.now();
          const quietMs = now - lastActivityAt;
          const open = openTools();
          if (open.length) {
            wakeMs = BACKGROUND_WAKE_MS;
            if (quietMs >= silenceMs) {
              return `agy left a command running and gave no sign of life for ${Math.round(silenceMs / 1000)}s, so the job stopped waiting: ${named(open)}`;
            }
            if (now - startedAt >= limitMs) {
              return `agy was still running a command ${Math.round(limitMs / 1000)}s after its turn ended, so the job stopped waiting: ${named(open)}`;
            }
            continue;
          }
          if (stepEndedSinceLastClose) {
            if (quietMs >= BACKGROUND_SETTLE_MS) return null;
          } else if (quietMs >= wakeMs) {
            if (!lateClose) onEvent({ type: "note", text: "agy said nothing more after its command ended" });
            return null;
          }
        }
        return null;
      };
      let backgroundError = null;

      // agy reports token counts per message, so a job that sends several adds them up.
      // What it spends on steps it takes after ending its turn is not in any of them.
      let usage = null;
      const send = async (message) => {
        const outcome = await Promise.race([
          client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: message }] }),
          client.failure,
          gaveUp
        ]);
        usage = addUsage(usage, toUsage(outcome?.usage));
        if (outcome?.stopReason === "end_turn") backgroundError ??= await settleBackground();
        return outcome;
      };

      let result = await send(prompt);
      for (let nudges = 0; nudges < MAX_NUDGES && unanswered.length && !cancelled && !backgroundError && result?.stopReason === "end_turn"; nudges += 1) {
        onEvent({ type: "note", text: "agy stopped at a declined request without answering; asking it to finish without" });
        messageBroken = true;
        result = await send(nudgeAfterDeclines(unanswered.splice(0)));
      }

      const stop = result?.stopReason;
      let status = "completed";
      let error = null;
      if (cancelled || stop === "cancelled") {
        status = "cancelled";
      } else if (stop !== "end_turn") {
        status = "failed";
        error = `agy stopped early (stopReason: ${stop ?? "unknown"}).`;
      } else if (backgroundError) {
        // What agy had said up to then is kept as the answer, under the error.
        status = "failed";
        error = backgroundError;
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
