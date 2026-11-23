// Newline-delimited JSON-RPC over a child process's stdio.
// Shared by both backends: `codex app-server` and `agy acp` speak the same framing.
import { spawn } from "node:child_process";
import { resolveCommand } from "./command.mjs";
import fs from "node:fs";
import readline from "node:readline";

import { stripAnsi } from "./text.mjs";

const METHOD_NOT_FOUND = -32601;

class RpcError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** The error for a request from the agent that this client has no answer to. */
export const notImplemented = (method) => new RpcError(`Client does not implement ${method}`, { code: METHOD_NOT_FOUND });

export class StdioRpcClient {
  /**
   * @param {object} options
   * @param {string} options.command            Executable to spawn.
   * @param {string[]} [options.args]
   * @param {string} [options.cwd]
   * @param {boolean} [options.includeJsonRpcField]  Add `"jsonrpc":"2.0"` to outgoing messages (ACP wants it).
   * @param {string | null} [options.traceFile]  Write every message sent and received to this file, one JSON object per line.
   */
  constructor({ command, args = [], cwd, includeJsonRpcField = false, traceFile = null }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.includeJsonRpcField = includeJsonRpcField;
    this.traceFile = traceFile;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {(method: string, params: any) => void} */
    this.onNotification = () => {};
    /** @type {(method: string, params: any) => any | Promise<any>} */
    this.onRequest = (method) => {
      throw notImplemented(method);
    };
    /** Rejects if the process dies; race it against anything awaited outside `request`. */
    this.failure = new Promise((_, reject) => {
      this.#rejectFailure = reject;
    });
    this.failure.catch(() => {}); // Never an unhandled rejection when nobody is racing it.
  }

  #rejectFailure;

  start() {
    const resolved = resolveCommand(this.command, this.args);
    this.child = spawn(resolved.command, resolved.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: resolved.shell ?? false,
      windowsHide: true
    });
    this.child.on("error", (error) => {
      const message =
        error.code === "ENOENT"
          ? `\`${this.command}\` was not found on PATH.`
          : `Failed to start \`${this.command}\`: ${error.message}`;
      this.#fail(new Error(message));
    });
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      const tail = this.stderrTail();
      this.#fail(
        new Error(
          `\`${this.command} ${this.args.join(" ")}\` exited unexpectedly (code=${code}, signal=${signal}).` +
            (tail ? `\n${tail}` : "")
        )
      );
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.#handleLine(line));
    return this;
  }

  stderrTail(maxLines = 6) {
    const clean = stripAnsi(this.stderr).trim();
    return clean ? clean.split("\n").slice(-maxLines).join("\n") : "";
  }

  request(method, params) {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ id, method, params });
    });
  }

  notify(method, params) {
    if (this.exitError || this.closed) return;
    this.#send({ method, params });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 1500);
    const hardTimer = setTimeout(() => child.kill("SIGKILL"), 4000);
    await exited;
    clearTimeout(timer);
    clearTimeout(hardTimer);
  }

  /** One line of the trace: when, which way ("sent" or "received"), and the message. */
  #trace(direction, message) {
    if (!this.traceFile) return;
    try {
      fs.appendFileSync(this.traceFile, `${JSON.stringify({ at: new Date().toISOString(), direction, message })}\n`, { mode: 0o600 });
    } catch {
      // A trace that cannot be written must not stop the turn.
    }
  }

  #send(message) {
    const payload = this.includeJsonRpcField ? { jsonrpc: "2.0", ...message } : message;
    this.#trace("sent", payload);
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // The exit handler reports the failure to pending requests.
    }
  }

  #fail(error) {
    if (this.exitError) return;
    this.exitError = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.#rejectFailure(error);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#trace("received", line);
      return; // Not protocol output; ignore.
    }
    this.#trace("received", message);

    const hasId = message.id !== undefined && message.id !== null;

    // Response to one of our requests.
    if (hasId && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new RpcError(message.error.message ?? "Unknown RPC error", { code: message.error.code }));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // Request from the agent (approvals, permission prompts).
    if (hasId && message.method) {
      Promise.resolve()
        .then(() => this.onRequest(message.method, message.params))
        .then(
          (result) => this.#send({ id: message.id, result: result ?? {} }),
          (error) =>
            this.#send({
              id: message.id,
              error: { code: error?.code ?? -32603, message: error?.message ?? String(error) }
            })
        );
      return;
    }

    if (message.method) {
      try {
        this.onNotification(message.method, message.params);
      } catch {
        // A handler bug must not take down the transport.
      }
    }
  }
}
