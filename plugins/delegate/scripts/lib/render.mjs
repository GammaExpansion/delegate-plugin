// Plain-text rendering of jobs. The output is read by Claude and relayed to the user,
// so it stays compact and labels everything the reader needs to act on.

import { effortLabel } from "./backends/shared.mjs";
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

/** The permission option a job ran with, and its sandbox override if it had one. */
const permissionOf = (job) => `${job.permission ?? "?"}${job.sandbox ? `, sandbox ${job.sandbox}` : ""}`;

const worktreeLine = (job) =>
  `worktree: ${job.worktree.path}${job.worktree.branch ? `  (branch ${job.worktree.branch})` : ""}`;

/**
 * Who is doing the work: the agent's name, with the model once the job knows it, and
 * the reasoning effort where the backend reports one apart from the model, as in
 * "Codex Agent (gpt-6.2-astra xHigh)". An agy model id already ends in its level.
 */
export function agentOf(job) {
  const name = job.agentName ?? job.backend;
  if (!job.model) return name;
  const effort = effortLabel(job.shownEffort);
  return `${name} (${job.model}${effort ? ` ${effort}` : ""})`;
}

function headline(job) {
  return [
    `[delegate] ${agentOf(job)}`,
    job.id,
    job.status,
    formatDuration(jobDurationMs(job)),
    permissionOf(job)
  ].join(" · ");
}

function renderAction(action) {
  const bits = [];
  if (action.status) bits.push(action.status);
  if (action.exitCode !== undefined && action.exitCode !== null) bits.push(`exit ${action.exitCode}`);
  if (action.permission === "denied") bits.push("permission denied");
  return `- [${action.kind}] ${oneLine(action.title, 160)}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

const isDeclined = (action) => action.permission === "denied" || action.status === "declined";

/** What to tell the reader of a result in which the delegate was refused something. */
const declinedNote = (job) =>
  `note: nobody can approve a request while a delegate runs, so these were declined. This turn ran with --permission ${job.permission ?? "?"}. To let the delegate do them, continue this conversation with an option that allows more.`;

/**
 * A finished job as the forwarding subagent hands it back: the answer, under the few
 * lines its reader needs in order to act on it. Everything else (the actions, the token
 * counts) is in the full record, which `result` prints.
 *
 * The session id is on every result, so that whoever continues the conversation finds
 * it in the latest one and never has to look further back.
 */
export function renderAnswer(job) {
  const result = job.result ?? {};
  const lines = [[`[delegate] ${agentOf(job)}`, job.status, formatDuration(jobDurationMs(job)), permissionOf(job), job.id].join(" · ")];
  if (job.sessionId) lines.push(`session: ${job.sessionId}`);
  if (job.worktree) lines.push(worktreeLine(job));
  if (result.error) lines.push(`error: ${result.error}`);
  if (job.status === "cancelled" && !result.error) lines.push("note: the run was cancelled before it finished.");
  const declined = (result.actions ?? []).filter(isDeclined);
  if (declined.length) {
    lines.push(`declined (${declined.length}):`, ...declined.slice(0, 10).map(renderAction));
    if (declined.length > 10) lines.push(`- … ${declined.length - 10} more`);
    lines.push(declinedNote(job));
  }
  if (job.answerFile) {
    // The answer went to a file, so that it does not have to be retyped by whoever passes
    // this on. All they pass on is where it is.
    const words = String(result.text ?? "").split(/\s+/).filter(Boolean).length;
    lines.push(`answer: ${job.answerFile}`, `The answer (${words.toLocaleString("en-US")} words) is in that file and is not repeated here. Read the file.`);
  } else {
    lines.push("", result.text ? result.text : "(no message)");
  }
  return lines.join("\n");
}

/**
 * What `run` and `wait` print while the job is not over. The first line never varies,
 * so that it can be told from an answer at a glance. The other two are ready to use:
 * what to show the user, and the command that waits for the next news.
 */
export const STILL_RUNNING = "[delegate] still running";

export function renderRunning(job, what, nextCommand) {
  const description = [agentOf(job), formatDuration(jobDurationMs(job)), what || "still working"].join(" · ");
  return [STILL_RUNNING, `description: ${description}`, `next: ${nextCommand}`].join("\n");
}

/** The full record of a finished job, for `result`. */
export function renderResult(job) {
  const result = job.result ?? {};
  const lines = [headline(job)];
  if (job.sessionId) {
    lines.push(`session: ${job.sessionId}  (continue this conversation with: --resume ${job.sessionId})`);
  }
  lines.push(`permission: ${permissionOf(job)}`);
  if (job.worktree) lines.push(worktreeLine(job));
  if (result.error) lines.push(`error: ${result.error}`);
  if (job.status === "cancelled" && !result.error) lines.push("note: the run was cancelled before it finished.");

  const actions = result.actions ?? [];
  if (actions.some(isDeclined)) lines.push(declinedNote(job));

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

export function renderStatusList(jobs) {
  if (!jobs.length) return "No delegate jobs for this workspace yet.";
  const rows = jobs.map((job) => ({
    id: job.id,
    backend: job.backend,
    status: job.status,
    permission: permissionOf(job),
    time: formatDuration(jobDurationMs(job)),
    task: oneLine(job.prompt, 60)
  }));
  const columns = ["id", "backend", "status", "permission", "time", "task"];
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
