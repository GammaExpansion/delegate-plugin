// Puts a stand-in for a backend's CLI in a folder, in the form that platform installs it:
// a shell script elsewhere, and on Windows a batch-file shim like the one npm writes,
// so the tests go through the same lookup a real `npm install -g` would.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function writeFakeBin(dir, name, script) {
  if (process.platform === "win32") {
    // npm's shim names a script under its own folder, so one is put there that loads the fake.
    fs.writeFileSync(path.join(dir, `${name}.mjs`), `await import(${JSON.stringify(pathToFileURL(script).href)});\n`);
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\n"${process.execPath}" "%~dp0\\${name}.mjs" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
}

/** A copy of `env` with `dir` first on PATH, whatever case the key has (Windows has "Path"). */
export function prependPath(env, dir) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ""}` };
}
