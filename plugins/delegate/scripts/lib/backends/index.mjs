// Backend registry. To add another agent CLI, implement the same three methods
// (`check`, `listModels` and `run`) in a new file and register it here. A backend also
// has a `name` (what --backend takes), a `label` (the product, as in "Codex") and an
// `agentName` (how the agent is shown to the user while it works, as in "Codex Agent").
import { agyBackend } from "./agy.mjs";
import { codexBackend } from "./codex.mjs";

/**
 * @typedef {object} RunOptions
 * @property {string} cwd                 Directory the agent works in.
 * @property {string} prompt              The task, self-contained.
 * @property {string} permissionMode      One of the modes in ../permission.mjs; the backend maps it to its own settings.
 * @property {string} [model]             Backend-specific model id.
 * @property {string} [effort]            Backend-specific reasoning effort.
 * @property {string} [resumeSessionId]   Continue this backend session instead of starting fresh.
 * @property {AbortSignal} [signal]       Abort to interrupt the running turn.
 * @property {(request: { summary: string, detail?: string }) => Promise<{ decision: "allow" | "deny", message: string | null }>} askUser
 *                                        Put a permission request to the user and wait for the answer.
 *                                        `summary` completes the sentence "<backend> asks to ...".
 *                                        A refusal may carry `message`: the user's own words on what
 *                                        to do instead, which the backend passes to its agent.
 * @property {(event: BackendEvent) => void} onEvent
 *
 * @typedef {{ type: "session", sessionId: string, model: string | null }
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
 *
 * @typedef {object} RunResult
 * @property {"completed" | "cancelled" | "failed"} status
 * @property {string | null} sessionId
 * @property {string | null} model
 * @property {string} text
 * @property {Action[]} actions
 * @property {{ inputTokens: number, outputTokens: number, totalTokens: number } | null} usage
 * @property {string | null} error
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
