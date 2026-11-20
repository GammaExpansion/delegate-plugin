// Plain-text rendering of jobs. The output is read by Claude and relayed to the user,
// so it stays compact and labels everything the reader needs to act on.

import { FALLBACK_MODE } from "./permission.mjs";
import { isActive } from "./state.mjs";
import { oneLine } from "./text.mjs";

const MAX_ACTIONS = 30;

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function jobDurationMs(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return end - start;
}

// A record written before permission modes existed has none.
const modeOf = (job) => job.permissionMode ?? FALLBACK_MODE;

const worktreeLine = (job) =>
  `worktree: ${job.worktree.path}${job.worktree.branch ? `  (branch ${job.worktree.branch})` : ""}`;

/** Who is doing the work: the agent's name, with the model once the job knows it. */
export function agentOf(job) {
  const name = job.agentName ?? job.backend;
  return job.model ? `${name} (${job.model})` : name;
}

function headline(job) {
  return [
    `[delegate] ${agentOf(job)}`,
    job.id,
    job.status,
    formatDuration(jobDurationMs(job)),
    modeOf(job)
  ].join(" · ");
}

function renderAction(action) {
  const bits = [];
  if (action.status) bits.push(action.status);
  if (action.exitCode !== undefined && action.exitCode !== null) bits.push(`exit ${action.exitCode}`);
  if (action.permission === "denied") bits.push("permission denied");
  return `- [${action.kind}] ${oneLine(action.title, 160)}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

export function renderResult(job) {
  const result = job.result ?? {};
  const lines = [headline(job)];
  if (job.sessionId) {
    lines.push(`session: ${job.sessionId}  (continue this conversation with: --resume ${job.sessionId})`);
  }
  lines.push(`permission mode: ${modeOf(job)}  (${job.permissionSource ?? "not recorded"})`);
  if (job.worktree) lines.push(worktreeLine(job));
  if (result.error) lines.push(`error: ${result.error}`);
  if (job.status === "cancelled" && !result.error) lines.push("note: the run was cancelled before it finished.");

  const actions = result.actions ?? [];
  const refused = actions.filter((action) => action.permission === "denied" || action.status === "declined").length;
  if (refused) {
    lines.push(
      `note: ${refused} action(s) were refused. The turn ran in permission mode "${modeOf(job)}".`
    );
  }

  lines.push("", "--- final message ---", result.text ? result.text : "(no message)");

  if (actions.length) {
    lines.push("", `--- actions (${actions.length}) ---`);
    lines.push(...actions.slice(0, MAX_ACTIONS).map(renderAction));
    if (actions.length > MAX_ACTIONS) lines.push(`- … ${actions.length - MAX_ACTIONS} more`);
  }

  if (result.usage) {
    const n = (value) => (Number.isFinite(value) ? value.toLocaleString("en-US") : "?");
    lines.push(
      "",
      `usage: input ${n(result.usage.inputTokens)} · output ${n(result.usage.outputTokens)} · total ${n(result.usage.totalTokens)}`
    );
  }
  return lines.join("\n");
}

/** The request a job is waiting on, for the caller that has to put it to the user. */
export function renderPending(job) {
  const { id, summary, detail } = job.pending;
  const lines = ["=== APPROVAL NEEDED ===", `request: ${id}`, `${agentOf(job)} asks to ${summary}`];
  for (const line of String(detail ?? "").split("\n")) if (line.trim()) lines.push(`  ${line}`);
  lines.push(`Put it to the user with: answer ${job.id} ${id} allow`);
  return lines.join("\n");
}

export function renderStarted(job) {
  return [
    `${headline(job)}`,
    `Started. Watch it and collect the result with: follow ${job.id} --offset 0`,
    `Stop it with: cancel ${job.id}`
  ].join("\n");
}

export function renderStatusList(jobs) {
  if (!jobs.length) return "No delegate jobs for this workspace yet.";
  const rows = jobs.map((job) => ({
    id: job.id,
    backend: job.backend,
    status: job.status,
    mode: modeOf(job),
    time: formatDuration(jobDurationMs(job)),
    task: oneLine(job.prompt, 60)
  }));
  const columns = ["id", "backend", "status", "mode", "time", "task"];
  const widths = Object.fromEntries(columns.map((c) => [c, Math.max(c.length, ...rows.map((r) => r[c].length))]));
  const line = (row) => columns.map((c) => row[c].padEnd(widths[c])).join("  ").trimEnd();
  return [line(Object.fromEntries(columns.map((c) => [c, c]))), ...rows.map(line)].join("\n");
}

export function renderJobDetail(job, logTail) {
  const lines = [headline(job), `task: ${oneLine(job.prompt, 300)}`];
  if (job.sessionId) lines.push(`session: ${job.sessionId}`);
  if (job.worktree) lines.push(worktreeLine(job));
  if (job.result?.error) lines.push(`error: ${job.result.error}`);
  if (logTail.length) lines.push("", "--- recent activity ---", ...logTail);
  if (isActive(job)) {
    lines.push("", `Still running. Stop it with: cancel ${job.id}`);
  } else {
    lines.push("", `Finished. Full output: result ${job.id}`);
  }
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
    const title = `${agentName ?? backend} (--backend ${backend})`;
    if (error) return `${title}\n  could not list its models: ${error}`;

    const hasFamilies = list.models.some((model) => model.family);
    const lines = [title];
    if (list.defaultModel) {
      lines.push(`  default: ${list.defaultModel}${list.defaultEffort ? `, effort ${list.defaultEffort}` : ""}   (marked * below)`);
    }
    lines.push("", ...(hasFamilies ? familyRows(list) : modelRows(list)).map((line) => (line ? `  ${line}` : "")), "");
    lines.push(
      hasFamilies
        ? `  ${list.models.length} ids. The thinking level is part of the id, as in --model ${list.models.find((model) => model.family)?.id ?? "<id>"}`
        : `  ${list.models.length} models. Pick one with --model <id>, and an effort with --effort <level>.`
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
        : backend.auth === "missing"
          ? "installed, not logged in"
          : "installed, login not checked";
    lines.push(`${backend.name}: ${state}${backend.version ? ` · ${backend.version}` : ""}`);
    if (backend.hint) lines.push(`  ${backend.hint}`);
  }
  return lines.join("\n");
}
