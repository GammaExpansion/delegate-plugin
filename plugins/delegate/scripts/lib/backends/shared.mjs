// What every backend does the same way, whichever agent it drives.
import { notImplemented } from "../rpc.mjs";
import { oneLine } from "../text.mjs";

/** How this plugin introduces itself to an agent. */
export const CLIENT_INFO = { name: "delegate-plugin", title: "Delegate plugin for Claude Code", version: "0.3.0" };

/**
 * For a request from the agent that nobody here can answer (a question for the user in
 * some form this plugin does not know, an MCP elicitation): note it, and refuse it.
 */
export function refuseUnknownRequest(onEvent, method, params) {
  onEvent({ type: "note", text: `backend asked for something this plugin cannot answer: ${method} ${oneLine(JSON.stringify(params ?? {}), 300)}` });
  throw notImplemented(method);
}

/** Token counts in the shape a RunResult carries, or null when the agent reported none. */
export function toUsage(usage) {
  return usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } : null;
}

/** A reasoning effort as it is shown next to a model's name: "high", "xHigh". */
export function effortLabel(effort) {
  if (typeof effort !== "string" || !effort.trim()) return null;
  const level = effort.trim().toLowerCase();
  return level === "xhigh" ? "xHigh" : level;
}

const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/** "astra" -> "Astra", "codex-spark" -> "Codex Spark". */
export const titleCase = (words) => words.split(/[-\s]+/).filter(Boolean).map(capitalise).join(" ");

/** The sum of two token counts, either of which may be missing. */
export function addUsage(a, b) {
  if (!a || !b) return a ?? b ?? null;
  const sum = (x, y) => (Number.isFinite(x) ? x : 0) + (Number.isFinite(y) ? y : 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens)
  };
}

/** "Approve for me", "approve_for_me" -> "approve-for-me". */
export const optionName = (value) => String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");

/**
 * The permission option a turn runs with: the one asked for, or the backend's default.
 * @param {{ label: string, permissions: Record<string, object>, defaultPermission: string }} backend
 */
export function pickPermission(backend, asked) {
  const name = asked === undefined || asked === null || asked === "" ? backend.defaultPermission : optionName(asked);
  if (!Object.hasOwn(backend.permissions, name)) {
    throw new Error(
      `${backend.label} has no permission option "${asked}". Its options: ${Object.keys(backend.permissions).join(", ")}.`
    );
  }
  return name;
}

/** `--sandbox` as "enabled" or "disabled", or null when it was not given. */
export function pickSandbox(asked) {
  if (asked === undefined || asked === null || asked === "") return null;
  const word = optionName(asked);
  if (word === "enabled" || word === "on") return "enabled";
  if (word === "disabled" || word === "off") return "disabled";
  throw new Error(`Unknown --sandbox "${asked}". Use enabled or disabled.`);
}
