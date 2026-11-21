// How to start a backend's CLI on this platform.
//
// On Windows, spawn() without a shell runs only real executables, and it does not try
// PATHEXT: `codex` installed with npm is `codex.cmd`, a batch-file shim, so spawning
// "codex" fails with ENOENT. Running the shim through cmd.exe would work, but then
// stopping a job kills cmd.exe and leaves the real process running. So an npm shim is
// read for the script it starts, and that script is run with Node directly.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{ command: string, args: string[], shell?: boolean }} Resolved
 */

/**
 * @param {string} name   The command as a user would type it, such as "codex".
 * @param {string[]} [args]
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {Resolved}
 */
export function resolveCommand(name, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return { command: name, args };
  const found = findOnPath(name, env);
  // Not found: spawn the bare name, so the caller sees the usual ENOENT.
  if (!found) return { command: name, args };
  const ext = path.extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { command: found, args };
  const script = npmShimScript(found);
  if (script) {
    // The shim prefers a node.exe installed beside it, and otherwise runs `node`.
    const bundled = path.join(path.dirname(found), "node.exe");
    return { command: fs.existsSync(bundled) ? bundled : process.execPath, args: [script, ...args] };
  }
  // Some other batch file. Only fixed arguments reach this point, never text from a task,
  // so cmd.exe's parsing of them is not a risk; the path is quoted for its spaces.
  return { command: `"${found}"`, args, shell: true };
}

/** execFileSync, with the command resolved as above. */
export function execCommandSync(name, args, options = {}) {
  const resolved = resolveCommand(name, args);
  return execFileSync(resolved.command, resolved.args, { ...options, shell: resolved.shell ?? false, windowsHide: true });
}

/** The first match for `name` on PATH, trying each PATHEXT extension, as cmd.exe would. */
function findOnPath(name, env) {
  const get = (key) => env[Object.keys(env).find((k) => k.toUpperCase() === key) ?? key];
  const exts = (get("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates = path.extname(name) ? [name] : exts.map((ext) => name + ext);
  const dirs = path.isAbsolute(name) || name.includes("\\") || name.includes("/") ? [""] : (get("PATH") || "").split(";");
  for (const dir of dirs) {
    const base = dir.replace(/^"(.*)"$/, "$1");
    if (dir && !base) continue;
    for (const candidate of candidates) {
      const full = base ? path.join(base, candidate) : candidate;
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return null;
}

/**
 * The script an npm, pnpm or Yarn shim runs, or null for any other batch file. Shims name
 * it relative to their own folder: `"%dp0%\node_modules\pkg\bin\cli.js" %*` (npm) or
 * `"%~dp0\..\pkg\bin\cli.js" %*` (older npm, pnpm).
 */
function npmShimScript(shimPath) {
  let text;
  try {
    text = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/"%~?dp0%?\\?([^"%]+?\.[cm]?js)"\s+%\*/i);
  if (!match) return null;
  const script = path.resolve(path.dirname(shimPath), match[1]);
  return fs.existsSync(script) ? script : null;
}
