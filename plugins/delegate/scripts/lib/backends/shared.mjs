// What every backend does the same way, whichever agent it drives.
import { notImplemented } from "../rpc.mjs";
import { oneLine } from "../text.mjs";

/** How this plugin introduces itself to an agent. */
export const CLIENT_INFO = { name: "delegate-plugin", title: "Delegate plugin for Claude Code", version: "0.2.1" };

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

/** What the agent is told when the user refused a request and said what to do instead. */
export function refusalReply(request, message) {
  return `Your request to ${request.summary} was refused. The user's reply:\n${message}`;
}
