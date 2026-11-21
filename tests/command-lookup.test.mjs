// Where a backend's program is looked for on Windows. The rule tested here does not need
// a Windows machine: it is about which directories are searched at all.
// Run from the repository root with: node --test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveCommand } from "../plugins/delegate/scripts/lib/command.mjs";

test("an empty PATH entry does not make the current directory a place to find a backend in", () => {
  // A project that carries a `codex.cmd` of its own, shaped like the shim npm writes.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delegate-lookup-test-")));
  fs.writeFileSync(path.join(project, "planted.js"), "");
  fs.writeFileSync(path.join(project, "codex.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\planted.js" %*\r\n');
  const elsewhere = path.join(project, "not-there");
  const lookup = (PATH) => resolveCommand("codex", ["--version"], { platform: "win32", env: { PATH, PATHEXT: ".cmd" } });
  const cwd = process.cwd();
  process.chdir(project);
  try {
    // Not found on PATH: the bare name, which the caller then fails to start.
    for (const PATH of [`${elsewhere};`, `;${elsewhere}`, `${elsewhere};;${elsewhere}`, `${elsewhere}; `, ""]) {
      assert.deepEqual(lookup(PATH), { command: "codex", args: ["--version"] }, `PATH=${JSON.stringify(PATH)}`);
    }
    // The same file is found when its directory really is on PATH, so the check above means something.
    assert.deepEqual(lookup(`${elsewhere};${project}`).args, [path.join(project, "planted.js"), "--version"]);
  } finally {
    process.chdir(cwd);
    fs.rmSync(project, { recursive: true, force: true });
  }
});
