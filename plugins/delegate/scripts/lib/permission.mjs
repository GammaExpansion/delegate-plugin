// Permission modes: what a delegate may do during one turn.
//
// The modes are Claude Code's own, by the same names, so that a delegate can simply
// follow the conversation it was started from. Each backend turns a mode into its own
// settings (see the POLICY tables in backends/codex.mjs and backends/agy.mjs). The fit
// is not exact, because Codex is governed by a sandbox and agy by permission callbacks.
//
// A mode says what a delegate may do without asking. When it wants more, the request
// goes to the user, except in dontAsk (refused) and bypassPermissions (never asked).

// How far a mode lets a delegate go without the user, lowest first. The first three
// are equal: none of them lets it change anything unasked.
const RANK = { plan: 0, default: 0, dontAsk: 0, acceptEdits: 1, auto: 2, bypassPermissions: 3 };

export const MODES = Object.keys(RANK);
export const FALLBACK_MODE = "default";

/** Whether `mode` lets a delegate do more than `other` does. */
export function allowsMoreThan(mode, other) {
  return (RANK[mode] ?? 0) > (RANK[other] ?? 0);
}

/**
 * Decide the mode for one turn. An explicit --permission-mode wins outright. Otherwise
 * the turn follows the permission mode of the Claude Code conversation the task came
 * from, which the plugin's PreToolUse hook passes along. With neither, it is "default".
 *
 * @param {{ explicit?: string, conversationMode?: string }} input
 * @returns {{ mode: string, source: string }}
 */
export function resolvePermissionMode({ explicit, conversationMode }) {
  if (explicit !== undefined) {
    if (!MODES.includes(explicit)) {
      throw new Error(`Unknown permission mode "${explicit}". Choose one of: ${MODES.join(", ")}.`);
    }
    return { mode: explicit, source: "--permission-mode flag" };
  }
  if (conversationMode !== undefined) {
    if (MODES.includes(conversationMode)) return { mode: conversationMode, source: "follows the conversation" };
    return { mode: FALLBACK_MODE, source: `the conversation's mode "${conversationMode}" is not one this plugin knows` };
  }
  return { mode: FALLBACK_MODE, source: "no conversation mode was passed" };
}
