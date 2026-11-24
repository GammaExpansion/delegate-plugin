// Backend registry. To add another agent CLI, implement the same four methods
// (`check`, which may be async, `listModels`, `settingsFor` and `run`) in a new file and
// register it here. A
// backend also has a `name` (what --backend takes), a `label` (the product, as in
// "Codex"), an `agentName` (how the agent is shown to the user while it works, as in
// "Codex Agent"), and its own permission options: `permissions`, keyed by the names
// --permission takes, and `defaultPermission`. `settingsFor({ permission, sandbox })`
// checks a choice and returns it by its proper names; it throws on one the backend lacks.
import { agyBackend } from "./agy.mjs";
import { codexBackend } from "./codex.mjs";

/**
 * @typedef {object} RunOptions
 * @property {string} cwd                 Directory the agent works in.
 * @property {string} prompt              The task, self-contained.
 * @property {string} [permission]        One of the backend's own permission options; its default when left out.
 * @property {string} [sandbox]           "enabled" or "disabled", to override the sandbox the option comes with.
 * @property {string} [model]             Backend-specific model id.
 * @property {string} [effort]            Backend-specific reasoning effort.
 * @property {string} [resumeSessionId]   Continue this backend session instead of starting fresh. If it cannot
 *                                        be continued the turn fails: no new session is started in its place.
 * @property {AbortSignal} [signal]       Abort to interrupt the running turn.
 * @property {string | null} [traceFile]  Write every message to and from the backend here (see DELEGATE_TRACE).
 * @property {(event: BackendEvent) => void} onEvent
 * @property {(request: ApprovalRequest) => Promise<string | { text: string } | null>} [onApproval]
 *           Asked when the agent wants to do something its permission option does not
 *           allow by itself. Resolves to the id of one of `request.choices` (null
 *           declines), or to `{ text }`, the
 *           user's own words: the request is declined and the words are passed on to the
 *           agent, during the turn where it takes them (Codex) and after it otherwise.
 *           Left out, every such request is declined.
 *
 * @typedef {object} ApprovalRequest
 * @property {string} kind            "command" | "edit" | "execute" | "approval" | ...
 * @property {string} title           The command, the files, or what the agent says it wants.
 * @property {string | null} cwd      Where a command would run, when the agent says.
 * @property {string | null} reason   Why, or which paths, when the agent says.
 * @property {{ id: string, label: string, allow: boolean, stop?: boolean }[]} choices
 *           The answers the user is offered, declining ones first, at most four. One that
 *           stops also ends the turn.
 *
 * @typedef {{ type: "session", sessionId: string, model: string | null, effort?: string | null }   effort only where it is not already part of the model id
 *   | { type: "action", action: Action, output?: string }      a tool call finished; output is its clipped text
 *   | { type: "progress", text: string }                       interim message, thinking, or a tool call starting
 *   | { type: "note", text: string }} BackendEvent
 *
 * @typedef {object} Action
 * @property {string} kind      "command" | "edit" | "read" | "execute" | "tool" | ...
 * @property {string} title
 * @property {string} [status]
 * @property {number | null} [exitCode]
 * @property {"allowed" | "denied"} [permission]
 * @property {boolean} [daemon]   The agent started it to keep running (a server), and does not wait for it.
 *
 * @typedef {object} RunResult
 * @property {"completed" | "cancelled" | "failed"} status
 * @property {string | null} sessionId
 * @property {string} [permission]   The option the turn ran with, where it is not the one asked for.
 * @property {string | null} model
 * @property {string} text
 * @property {Action[]} actions
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number } | null} usage
 * @property {string | null} error
 * @property {string[]} [notes]   What the reader of a result should know besides, such as a command left running.
 *
 * @typedef {object} ModelList
 * @property {{ id: string, name: string, efforts: string[], family?: string, familyName?: string, level?: string }[]} models
 *           efforts is empty when the backend lists none. When a backend has one id per
 *           thinking level, `family`, `familyName` and `level` say which ids go together.
 * @property {string | null} defaultModel    used when --model is left out, if the backend can tell
 * @property {string | null} defaultEffort
 * @property {string | null} note
 */

export const BACKENDS = {
  codex: codexBackend,
  agy: agyBackend
};

export function getBackend(name) {
  const backend = BACKENDS[name];
  if (!backend) {
    throw new Error(`Unknown backend "${name}". Available: ${Object.keys(BACKENDS).join(", ")}.`);
  }
  return backend;
}
