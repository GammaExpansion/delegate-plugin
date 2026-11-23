// What the bridge prints for people and for Claude: a turn's report, the model lists and
// the setup check.
import { effortLabel } from "./backends/shared.mjs";
import { oneLine } from "./text.mjs";

/** "17.1s", "3m 05s", "1h 02m". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "Codex Agent (gpt-6.2-astra xHigh)", or the bare name while the model is not known. */
export function agentLabel(backend, model, effort) {
  if (!model) return backend.agentName;
  const level = effortLabel(effort);
  return `${backend.agentName} (${model}${level ? ` ${level}` : ""})`;
}

function renderAction(action) {
  const bits = [];
  if (action.status) bits.push(action.status);
  if (action.exitCode !== undefined && action.exitCode !== null) bits.push(`exit ${action.exitCode}`);
  if (action.permission === "denied") bits.push("permission denied");
  if (action.daemon) bits.push("started to keep running");
  return `- [${action.kind}] ${oneLine(action.title, 160)}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

const isDeclined = (action) => action.permission === "denied" || action.status === "declined";

/** Why the steps listed under "declined" were not done. */
function declinedNote(approvals, mode) {
  if (approvals === "ask") {
    return "note: the user was asked about these and did not allow them, or the delegate was stopped before an answer came.";
  }
  return `note: this conversation is in ${mode ?? "a"} permission mode, in which nobody is asked, so these were declined. They can be done once the user switches the conversation to a mode that allows them and the delegate is asked again.`;
}

/**
 * One finished turn as its subagent hands it back: a headline, how the turn ended, what
 * was declined, and then the delegate's answer, unchanged.
 * @param {{ backend: object, permission: string, approvals: string, mode?: string | null,
 *   model: string | null, effort: string | null, durationMs: number,
 *   result: import("./backends/index.mjs").RunResult }} turn
 */
export function renderReport({ backend, permission, approvals, mode, model, effort, durationMs, result }) {
  const lines = [[`[delegate] ${agentLabel(backend, model, effort)}`, result.status, formatDuration(durationMs), permission].join(" · ")];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.status === "cancelled" && !result.error) lines.push("note: the run was stopped before it finished.");
  for (const note of result.notes ?? []) lines.push(`note: ${note}`);
  const declined = (result.actions ?? []).filter(isDeclined);
  if (declined.length) {
    lines.push(`declined (${declined.length}):`, ...declined.slice(0, 10).map(renderAction));
    if (declined.length > 10) lines.push(`- … ${declined.length - 10} more`);
    lines.push(declinedNote(approvals, mode));
  }
  lines.push("", result.text ? result.text : "(no message)");
  return lines.join("\n");
}

// Reasoning efforts and thinking levels, weakest first.
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const byLevel = (a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b);

/** "low → ultra" for an unbroken run of levels, otherwise the levels one by one. */
function levelRange(levels) {
  const sorted = [...levels].sort(byLevel);
  if (sorted.length < 3) return sorted.join(" ");
  const places = sorted.map((level) => LEVELS.indexOf(level));
  const unbroken = places.every((place, i) => place !== -1 && (i === 0 || place === places[i - 1] + 1));
  return unbroken ? `${sorted[0]} → ${sorted[sorted.length - 1]}` : sorted.join(" ");
}

/** Rows as a table: columns padded to the widest cell, blank rows kept as gaps. */
function table(header, rows) {
  const widths = header.map((_, column) => Math.max(...[header, ...rows.filter(Boolean)].map((row) => row[column].length)));
  const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("   ").trimEnd();
  return [line(header), ...rows.map((row) => (row ? line(row) : ""))];
}

const sameWords = (a, b) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "gpt-6.2" for gpt-6.2-astra: the ids that share it are listed together. */
const generationOf = (id) => id.match(/^[a-z]+-\d+(?:\.\d+)?(?=-|$)/)?.[0] ?? null;

/**
 * Models that each have an id and a list of efforts (Codex). Listed newest generation
 * first with a gap between generations, and the model's own name only where it says
 * more than the id does (an alias, for instance).
 */
function modelRows(list) {
  const generations = [];
  for (const model of list.models) {
    const key = generationOf(model.id);
    let group = generations.find((entry) => entry.key === key);
    if (!group) generations.push((group = { key, models: [] }));
    group.models.push(model);
  }
  const version = (key) => (key ? Number(key.replace(/^[a-z]+-/, "")) : -1);
  generations.sort((a, b) => version(b.key) - version(a.key));

  const rows = [];
  for (const group of generations) {
    if (rows.length) rows.push(null);
    for (const model of group.models) {
      rows.push([
        `${model.id === list.defaultModel ? "*" : " "} ${model.id}`,
        model.efforts.length ? levelRange(model.efforts) : "-",
        sameWords(model.name, model.id) ? "" : model.name
      ]);
    }
  }
  return table(["  MODEL", "EFFORT", "NAME"], rows);
}

/**
 * Models whose thinking level is part of the id (agy): one row per model, with its
 * levels, in place of one row per id.
 */
function familyRows(list) {
  const families = [];
  for (const model of list.models) {
    const key = model.family ?? model.id;
    let family = families.find((entry) => entry.key === key);
    if (!family) families.push((family = { key, name: model.familyName ?? model.name, levels: [], ids: [] }));
    if (model.level) family.levels.push(model.level);
    family.ids.push(model.id);
  }
  const rows = families.map((family) => [
    family.name,
    family.levels.sort(byLevel).join(" ") || "-",
    family.levels.length > 1 ? `${family.key}-<level>` : family.ids[0]
  ]);
  return table(["MODEL", "LEVELS", "ID"], rows);
}

/** @param {{ backend: string, agentName?: string, list?: import("./backends/index.mjs").ModelList, error?: string }[]} entries */
export function renderModels(entries) {
  const blocks = entries.map(({ backend, agentName, list, error }) => {
    const title = `${agentName ?? backend} (subagent delegate:${backend})`;
    if (error) return `${title}\n  could not list its models: ${error}`;

    const hasFamilies = list.models.some((model) => model.family);
    const lines = [title];
    if (list.defaultModel) {
      lines.push(`  default: ${list.defaultModel}${list.defaultEffort ? `, effort ${list.defaultEffort}` : ""}   (marked * below)`);
    }
    lines.push("", ...(hasFamilies ? familyRows(list) : modelRows(list)).map((line) => (line ? `  ${line}` : "")), "");
    lines.push(
      hasFamilies
        ? `  ${list.models.length} ids. The thinking level is part of the id: put --model ${list.models.find((model) => model.family)?.id ?? "<id>"} on the first line of the prompt.`
        : `  ${list.models.length} models. Put --model <id>, and --effort <level> if wanted, on the first line of the prompt.`
    );
    if (list.note) lines.push(`  ${list.note}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n\n");
}

export function renderSetup(report) {
  const lines = [`node: ${report.node.version} ${report.node.ok ? "(ok)" : "(needs 18.18 or later)"}`];
  for (const backend of report.backends) {
    const state = !backend.installed
      ? "not installed"
      : backend.auth === "ok"
        ? "ready"
        : backend.auth === "provider"
          ? "ready (own model provider, no login needed)"
          : backend.auth === "missing"
          ? "installed, not logged in"
          : "installed, login not checked";
    lines.push(`${backend.name}: ${state}${backend.version ? ` · ${backend.version}` : ""}`);
    if (backend.hint) lines.push(`  ${backend.hint}`);
  }
  return lines.join("\n");
}
