#!/usr/bin/env node
// The plugin's Node half. The hooks module (hooks/register.ts) runs inside Claude Code
// with no Node of its own, and a backend needs a process that holds a JSON-RPC
// conversation over stdio, so the module starts this script for each delegate turn.
//
//   bridge.mjs run              one turn. The request comes as JSON on stdin, which is
//                               then closed. Events go out as JSON lines on stdout.
//   bridge.mjs models [backend] the models each backend accepts, as text
//   bridge.mjs setup            whether Node and each backend's CLI are ready, as text
//
// `run` and the module talk through a control directory the bridge makes for the turn and
// names in its first event. Since stdin is closed, that is the way back: the module writes
// `answer-<id>.json` there to answer a request for approval, and `cancel` to stop the
// turn. The bridge looks for them a few times a second.
//
// Events, one JSON object per line:
//   { type: "ready", controlDir }
//   { type: "event", event }                 a BackendEvent (see lib/backends/index.mjs)
//   { type: "approval", id, request }        an ApprovalRequest; answer with answer-<id>.json
//                                            holding { "choice": "<id of one of request.choices>" },
//                                            or { "text": "..." }: the user's own words, which
//                                            decline the request and are passed on to the agent
//   { type: "result", result, report }       the RunResult, and the report for Claude
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { BACKENDS, getBackend } from "./lib/backends/index.mjs";
import { renderModels, renderReport, renderSetup } from "./lib/report.mjs";

const POLL_MS = 150;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

/** Where DELEGATE_TRACE=1 has a turn write every JSON-RPC message, or null. */
function traceFileFor(backendName) {
  if (process.env.DELEGATE_TRACE !== "1") return null;
  const dir = path.join(os.tmpdir(), "delegate-plugin", "traces");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${backendName}.trace.jsonl`);
}

/**
 * @typedef {object} TurnRequest
 * @property {string} backend          "codex" | "agy"
 * @property {string} cwd
 * @property {string} prompt
 * @property {string} permission       one of the backend's own options
 * @property {"enabled" | "disabled" | null} [sandbox]   "disabled" to run without the option's sandbox, "enabled" to add one
 * @property {"ask" | "decline"} approvals   whether requests beyond the option are put to the user
 * @property {string | null} [mode]    the conversation's permission mode, for the report
 * @property {string | null} [model]
 * @property {string | null} [effort]
 * @property {string | null} [resumeSessionId]
 */

async function cmdRun() {
  /** @type {TurnRequest} */
  const request = JSON.parse(await readStdin());
  const backend = getBackend(request.backend);
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-ctl-"));
  const controller = new AbortController();
  const pending = new Map();
  let nextId = 1;

  const settleAll = () => {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };
  controller.signal.addEventListener("abort", settleAll, { once: true });

  const poll = setInterval(() => {
    if (!controller.signal.aborted && fs.existsSync(path.join(controlDir, "cancel"))) controller.abort();
    for (const [id, resolve] of pending) {
      let text;
      try {
        text = fs.readFileSync(path.join(controlDir, `answer-${id}.json`), "utf8");
      } catch {
        continue;
      }
      let answer = null;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.choice === "string") answer = parsed.choice;
        else if (typeof parsed.text === "string" && parsed.text.trim()) answer = { text: parsed.text };
        else if (typeof parsed.allow === "boolean") answer = parsed.allow;
      } catch {
        // Unreadable is no.
      }
      pending.delete(id);
      resolve(answer);
    }
  }, POLL_MS);

  // Claude Code stops the bridge when the subagent is stopped. The turn is interrupted
  // then, as it would be through the control directory.
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  emit({ type: "ready", controlDir });

  const startedAt = Date.now();
  let shown = { model: request.model ?? null, effort: null };
  const onEvent = (event) => {
    if (event.type === "session") shown = { model: event.model ?? shown.model, effort: event.effort ?? null };
    emit({ type: "event", event });
  };
  const onApproval =
    request.approvals === "ask"
      ? (ask) =>
          new Promise((resolve) => {
            if (controller.signal.aborted) return resolve(null);
            const id = nextId++;
            pending.set(id, resolve);
            emit({ type: "approval", id, request: ask });
          })
      : undefined;

  let result;
  try {
    result = await backend.run({
      cwd: request.cwd,
      prompt: request.prompt,
      permission: request.permission,
      sandbox: request.sandbox || undefined,
      model: request.model || undefined,
      effort: request.effort || undefined,
      resumeSessionId: request.resumeSessionId || undefined,
      signal: controller.signal,
      traceFile: traceFileFor(backend.name),
      onEvent,
      onApproval
    });
  } catch (error) {
    result = {
      status: controller.signal.aborted ? "cancelled" : "failed",
      sessionId: request.resumeSessionId ?? null,
      model: shown.model,
      text: "",
      actions: [],
      usage: null,
      error: error?.message ?? String(error)
    };
  } finally {
    clearInterval(poll);
    settleAll();
    fs.rmSync(controlDir, { recursive: true, force: true });
  }

  const report = renderReport({
    backend,
    permission: request.permission,
    sandbox: request.sandbox ?? null,
    approvals: request.approvals,
    mode: request.mode ?? null,
    model: result.model ?? shown.model,
    effort: shown.effort,
    durationMs: Date.now() - startedAt,
    result
  });
  emit({ type: "result", result, report });
  return 0;
}

async function cmdModels(argv) {
  const { options, positionals } = parseArgs(argv, { booleans: ["json"], values: ["cwd"] });
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const wanted = positionals[0];
  const backends = wanted ? [getBackend(wanted)] : Object.values(BACKENDS);
  const entries = await Promise.all(
    backends.map(async (backend) => {
      try {
        return { backend: backend.name, agentName: backend.agentName, list: await backend.listModels({ cwd }) };
      } catch (error) {
        return { backend: backend.name, agentName: backend.agentName, error: error?.message ?? String(error) };
      }
    })
  );
  console.log(options.json ? JSON.stringify(entries, null, 2) : renderModels(entries));
  return entries.some((entry) => entry.list) ? 0 : 1;
}

async function cmdSetup(argv) {
  const { options } = parseArgs(argv, { booleans: ["json"] });
  const [major, minor] = process.versions.node.split(".").map(Number);
  const report = {
    node: { version: process.versions.node, ok: major > 18 || (major === 18 && minor >= 18) },
    backends: await Promise.all(
      Object.values(BACKENDS).map(async (backend) => ({ name: backend.name, label: backend.label, ...(await backend.check()) }))
    )
  };
  console.log(options.json ? JSON.stringify(report, null, 2) : renderSetup(report));
  return 0;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "run":
      return cmdRun();
    case "models":
      return cmdModels(argv);
    case "setup":
      return cmdSetup(argv);
    default:
      throw new Error(`Unknown command "${command ?? ""}". Use run, models or setup.`);
  }
}

/**
 * Exit once everything printed so far has left the process. Output to a pipe is written
 * asynchronously, so calling process.exit() directly cuts off whatever is still queued.
 */
function exitWhenFlushed(code) {
  const exit = () => process.exit(code);
  process.stdout.on("error", exit);
  process.stderr.on("error", exit);
  process.stdout.write("", () => process.stderr.write("", exit));
}

main().then(
  (code) => exitWhenFlushed(code ?? 0),
  (error) => {
    const message = error?.message ?? String(error);
    if (process.argv[2] === "run") emit({ type: "error", message });
    console.error(`[delegate] ${message}`);
    exitWhenFlushed(2);
  }
);
