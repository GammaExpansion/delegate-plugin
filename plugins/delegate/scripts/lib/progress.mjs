// A stretch of the job log, boiled down. `wait` tells its caller what the delegate did
// last in one line (statusLine), made from a compact view of the log (compactLog).
//
// The caller is a model that keeps everything it reads and pays for it again on every
// later call, so the view holds what a progress note can use and nothing else:
//   - no time stamps, and no entries about the job starting, its session, or its end
//     (the result that follows says those)
//   - reasoning ("thinking:") and permission traces are left out
//   - a command is shown without the shell it was wrapped in, and paths inside the
//     working directory are shown relative to it
//   - of a command's output only the last two lines are kept
//   - interim messages are cut to a few hundred characters
//   - a "starting ..." entry is dropped when the same batch shows how that step ended
// The full log stays on disk; byte offsets always refer to it, not to this view.
import fs from "node:fs";

import { splitLogEntries } from "./state.mjs";
import { oneLine } from "./text.mjs";

const HOUSEKEEPING = /^(?:started \S+ \(|agy ended its turn with a command still running|session \S+(?: · model |$)|finished: |thinking:|permission request:)/;
const SHELL_WRAPPER = /^(.*?: )?\/(?:usr\/)?bin\/(?:zsh|bash|sh) -l?c (['"])(.*)\2$/s;

/** `/bin/zsh -lc 'cat x'` -> `cat x`, when taking the quotes off cannot change the meaning. */
function unwrapShell(line) {
  const match = line.match(SHELL_WRAPPER);
  return match && !match[3].includes(match[2]) ? `${match[1] ?? ""}${match[3]}` : line;
}

/** Shorten paths under `cwd` to relative ones. `cwd` may be written with or without symlinks resolved. */
function relativeTo(cwd) {
  if (!cwd) return (line) => line;
  const roots = new Set([cwd]);
  try {
    roots.add(fs.realpathSync(cwd));
  } catch {
    // Gone: only the path as given.
  }
  const prefixes = [...roots].map((root) => `${root.replace(/\/+$/, "")}/`).sort((a, b) => b.length - a.length);
  return (line) => prefixes.reduce((text, prefix) => text.split(prefix).join(""), line);
}

/**
 * @param {string} text   A stretch of the job log.
 * @param {{ cwd?: string }} [options]   The job's working directory, for relative paths.
 */
export function compactLog(text, { cwd } = {}) {
  const relative = relativeTo(cwd);
  const entries = splitLogEntries(text)
    .map(({ body, rest }) => ({ body: relative(unwrapShell(body)), rest: rest.filter((line) => line.trim()).map(relative) }))
    .filter(({ body, rest }) => (body.trim() || rest.length) && !HOUSEKEEPING.test(body));

  // A "starting ..." entry says nothing once the same batch also reports how it ended.
  const finished = new Set();
  for (const { body } of entries) {
    const match = body.match(/^\S+ (?:completed|failed|declined)(?: \(exit -?\d+\))?: (.*)$/s);
    if (match) finished.add(match[1]);
  }

  const out = [];
  for (const { body, rest } of entries) {
    const starting = body.match(/^(?:starting \S+|running command): (.*)$/s);
    if (starting && finished.has(starting[1])) continue;
    if (body.startsWith("message:")) {
      out.push(oneLine([body, ...rest].join(" "), 400));
      continue;
    }
    out.push(oneLine(body, 300));
    if (rest.length > 2) out.push(`  [${rest.length - 2} earlier lines of output not shown]`);
    for (const line of rest.slice(-2)) out.push(`  ${oneLine(line, 160)}`);
  }
  return out.join("\n");
}

// The same step in fewer words, for a line that has to fit beside the agent's name.
const REWORDED = [
  [/^running command: (.*)$/s, (m) => `running ${m[1]}`],
  [/^command (?:completed|failed)(?: \((exit -?\d+)\))?: (.*)$/s, (m) => `ran ${m[2]}${m[1] ? ` (${m[1]})` : ""}`],
  [/^\S+ declined: (.*)$/s, (m) => `declined: ${m[1]}`],
  [/^declined \([^)]*\): (.*)$/s, (m) => `declined: ${m[1]}`],
  [/^starting (\S+): (.*)$/s, (m) => `${m[1]}: ${m[2]}`],
  [/^message: (.*)$/s, (m) => m[1]]
];

/**
 * What the delegate did last in a stretch of the log, as one line, or "" when the
 * stretch holds nothing worth telling. This is all a follower is shown of the log.
 * @param {string} text
 * @param {{ cwd?: string, max?: number }} [options]
 */
export function statusLine(text, { cwd, max = 110 } = {}) {
  const steps = compactLog(text, { cwd })
    .split("\n")
    .filter((line) => line && !line.startsWith("  "));
  const last = steps[steps.length - 1];
  if (!last) return "";
  for (const [pattern, reword] of REWORDED) {
    const match = last.match(pattern);
    if (match) return oneLine(reword(match), max);
  }
  return oneLine(last, max);
}
