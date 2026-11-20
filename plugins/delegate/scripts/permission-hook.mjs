#!/usr/bin/env node
// PreToolUse hook for Bash. It acts only on two commands of this plugin's own script:
// the one that starts a delegate task (`companion.mjs task ...`) and the one that
// answers a delegate's permission request (`companion.mjs answer ...`). See lib/hook.mjs
// for what it does with them. Every other Bash call passes through untouched.
//
// If the hook itself fails, the command runs as written. A task then gets no
// conversation mode, so it runs in "default" mode, and an approval is not accepted,
// because it lacks the mark only this hook can give it.
import process from "node:process";
import { fileURLToPath } from "node:url";

// The script's file name, as in lib/hook.mjs. Spelled out here so that the check below
// can run before anything else is loaded.
const SCRIPT_NAME = "companion.mjs";
const COMPANION = fileURLToPath(new URL(`./${SCRIPT_NAME}`, import.meta.url));

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

try {
  const input = JSON.parse(await readStdin());
  const command = input?.tool_input?.command;
  // This runs before every Bash call of the session, and nearly all of them end here:
  // a command that does not name the script is none of the hook's business, so nothing
  // more is loaded for it.
  if (input?.tool_name === "Bash" && typeof command === "string" && command.includes(SCRIPT_NAME)) {
    const { decide } = await import("./lib/hook.mjs");
    // Job records are only needed to word an approval. A job is found by its id alone,
    // whatever directory this command or the job itself runs in.
    const state = /\banswer\b/.test(command) ? await import("./lib/state.mjs") : null;
    const lookup = (jobId) => {
      const found = state?.locateJob(jobId);
      return found ? { pending: found.job.pending ?? null, secret: state.readSecret(found.home, jobId) } : null;
    };
    const verdict = decide({ command, mode: input.permission_mode, companionPath: COMPANION, lookup });
    if (verdict) {
      const output = { hookEventName: "PreToolUse" };
      if (verdict.decision) {
        output.permissionDecision = verdict.decision;
        output.permissionDecisionReason = verdict.reason;
      }
      if (verdict.command && verdict.decision !== "deny") {
        output.updatedInput = { ...input.tool_input, command: verdict.command };
      }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: output }));
    }
  }
} catch {
  // Not ours to break: let the command run as written.
}
process.exit(0);
