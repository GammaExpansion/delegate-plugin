// What the PreToolUse hook decides about one Bash command. Kept apart from the hook
// script so that it can be tested: it reads nothing but the two paths it compares.
//
// The hook concerns itself with two commands of this plugin's own script, and leaves
// every other command exactly as it was.
//
// The command that starts a delegate task:
//
//   node "<plugin>/scripts/companion.mjs" task [--flag value ...] <<'MARKER'
//   <task text>
//   MARKER
//
//   1. it adds the conversation's permission mode, so a task with no --permission-mode
//      of its own follows the conversation
//   2. it has Claude Code ask the user when the task names a mode that allows more than
//      the conversation has
//   3. it refuses the command when the task text could end up being run by the shell
//
// The command that answers a delegate's permission request:
//
//   node "<plugin>/scripts/companion.mjs" answer <job> <request> allow|deny
//
//   An approval it turns into a question for the user, worded from the job's own record
//   of what the delegate asked for, and marks with the job's secret so that the script
//   can tell the approval came this way. A refusal goes through.
import fs from "node:fs";
import path from "node:path";

import { CONVERSATION_MODE_FLAG, TOKEN_FLAG } from "./args.mjs";
import { FALLBACK_MODE, MODES, allowsMoreThan } from "./permission.mjs";

export const SCRIPT_NAME = "companion.mjs";

// The only shell words accepted after `task` or `answer`. None of them can expand to
// anything: no variables, no command substitution, no globbing, no operators.
const BARE = String.raw`[A-Za-z0-9._:@/+=,%-]+`;
const SINGLE_QUOTED = String.raw`'[^'\n]*'`;
const DOUBLE_QUOTED = "\"[^\"$`\\\\\\n]*\"";
const WORD = new RegExp(String.raw`\s+(${BARE}|${SINGLE_QUOTED}|${DOUBLE_QUOTED})`, "y");

const HEAD = new RegExp(
  String.raw`^\s*node\s+(${BARE.replace("%-", "%~-")}|${SINGLE_QUOTED}|${DOUBLE_QUOTED})\s+(task|answer)(?=\s|$)`
);
const HEREDOC = /\s*<<(-?)\s*(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)")\s*$/;
const SUBCOMMAND_NEXT = /^["']?\s+(task|answer)(?=\s|$)/;

const unquote = (word) => (/^["']/.test(word) ? word.slice(1, -1) : word);

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

const SHAPE = [
  "A delegate task has to be started in exactly this shape:",
  "  node \"<path>/scripts/companion.mjs\" task [--flag value ...] <<'MARKER'",
  "  <task text>",
  "  MARKER",
  "The first line may hold nothing but flags and plain values: no variables, no $( ), no",
  "pipes or other shell syntax, and nothing may follow the closing marker. Send the task",
  "again in that shape."
].join("\n");

const ANSWER_SHAPE = [
  "An answer to a delegate's permission request has to be given in exactly one of these",
  "shapes, with nothing else in the command:",
  "  node \"<path>/scripts/companion.mjs\" answer <job-id> <request-id> allow",
  "  node \"<path>/scripts/companion.mjs\" answer <job-id> <request-id> deny",
  "  node \"<path>/scripts/companion.mjs\" answer <job-id> <request-id> deny <<'MARKER'",
  "  <the user's reply>",
  "  MARKER",
  "Send it again in one of those shapes."
].join("\n");

const FULL_PATH = [
  "This command runs the delegate script by a path the plugin cannot check. Start it with",
  "the script's full path, as the first thing in the command, with no `cd` before it:"
].join("\n");

// How much of a request the user is shown before the rest is summed up.
const SHOWN_LINES = 40;
const SHOWN_LINE_CHARS = 600;

const deny = (reason) => ({ decision: "deny", reason });

/**
 * What a delegate asked for, as the user will read it. A long request is cut, and then
 * says so and by how much: the user must never take a part for the whole.
 */
function shownDetail(detail) {
  const lines = String(detail ?? "").split("\n").filter((line) => line.trim());
  const shown = lines.slice(0, SHOWN_LINES).map((line) =>
    line.length > SHOWN_LINE_CHARS
      ? `  ${line.slice(0, SHOWN_LINE_CHARS)} [... ${line.length - SHOWN_LINE_CHARS} more characters on this line are not shown]`
      : `  ${line}`
  );
  if (lines.length > SHOWN_LINES) {
    shown.push(`  [... ${lines.length - SHOWN_LINES} more lines are not shown. Refuse if you need to see all of it.]`);
  }
  return shown;
}

/**
 * Every place in the command where some companion.mjs is run with `task` or `answer`:
 * the path as written, and which of the two. Found by plain search, because a pattern
 * that can start anywhere takes quadratic time on a long unbroken token.
 */
function* checkedCalls(command) {
  for (let at = command.indexOf(SCRIPT_NAME); at !== -1; at = command.indexOf(SCRIPT_NAME, at + 1)) {
    const end = at + SCRIPT_NAME.length;
    const next = command.slice(end, end + 32).match(SUBCOMMAND_NEXT);
    if (!next) continue;
    let start = at;
    while (start > 0 && !/[\s"']/.test(command[start - 1])) start -= 1;
    yield { scriptPath: command.slice(start, end), subcommand: next[1] };
  }
}

/**
 * Take a trailing quoted heredoc off the first line. Returns the line without it, the
 * heredoc as written and its marker, or a refusal when a `<<` is there in any other form.
 */
function splitHeredoc(text) {
  if (!text.includes("<<")) return { text, heredocText: "", marker: null, stripTabs: false };
  const heredoc = text.match(HEREDOC);
  if (!heredoc) {
    return {
      refusal: "The heredoc marker has to be a plain name in single quotes (<<'MARKER'), so that the shell passes the text through untouched."
    };
  }
  return { text: text.slice(0, heredoc.index), heredocText: heredoc[0], marker: heredoc[2] ?? heredoc[3], stripTabs: heredoc[1] === "-" };
}

/** A refusal if the heredoc's text would close it early and leave the rest to the shell. */
function markerProblem({ marker, stripTabs }, followingLines) {
  const lines = followingLines.split("\n");
  const closing = lines.findIndex((line) => (stripTabs ? line.replace(/^\t+/, "") : line) === marker);
  if (closing === -1 || !lines.slice(closing + 1).some((line) => line.trim())) return null;
  return `The text contains a line that is exactly the heredoc marker "${marker}". The shell would stop reading there and run the rest of the text as commands. Send the same command again with a different marker, one that does not appear anywhere in the text.`;
}

/** Split what follows the head into its plain words, or null if it holds anything else. */
function plainWords(text) {
  const words = [];
  WORD.lastIndex = 0;
  let consumed = 0;
  for (let match; (match = WORD.exec(text)); ) {
    words.push(match[1]);
    consumed = WORD.lastIndex;
  }
  return text.slice(consumed).trim() ? null : words;
}

/**
 * The one grammar both commands share: plain words, then at most one quoted heredoc
 * whose text cannot close it early, and nothing else. Returns the words and the heredoc,
 * or the refusal to send back (`shape` describes the expected form of this command).
 */
function checkedTail(rest, followingLines, shape) {
  const heredoc = splitHeredoc(rest);
  if (heredoc.refusal) return { refusal: `${heredoc.refusal}\n${shape}` };
  const words = plainWords(heredoc.text);
  if (!words) return { refusal: shape };
  if (heredoc.marker === null) {
    if (followingLines.trim()) return { refusal: shape };
  } else {
    const problem = markerProblem(heredoc, followingLines);
    if (problem) return { refusal: problem };
  }
  return { words, heredoc };
}

/** The words without `--name value` and `--name=value`, however often they occur. */
function withoutFlag(words, name) {
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    const value = unquote(words[i]);
    if (value === `--${name}`) i += 1;
    else if (!value.startsWith(`--${name}=`)) kept.push(words[i]);
  }
  return kept;
}

/** The value given for `--name`, in either spelling. The last one wins, as in the script. */
function flagValue(words, name) {
  let found;
  words.map(unquote).forEach((value, i, all) => {
    if (value === `--${name}` && i + 1 < all.length) found = all[i + 1];
    else if (value.startsWith(`--${name}=`)) found = value.slice(name.length + 3);
  });
  return found;
}

/**
 * `answer <job> <request> allow|deny`. A refusal goes straight through, with the user's
 * reply if it carries one. An approval is the user's to give: Claude Code asks them,
 * shown what the delegate wants in the words of the job's own record, never the caller's.
 */
function decideAnswer({ head, rest, followingLines, lookup }) {
  const tail = checkedTail(rest, followingLines, ANSWER_SHAPE);
  if (tail.refusal) return deny(tail.refusal);
  // A token already on the line did not come from the hook.
  const plain = withoutFlag(tail.words, TOKEN_FLAG).map(unquote);
  const [jobId, requestId, decision] = plain;
  // The shapes of the two ids are those made by newJobId() in state.mjs and by the worker.
  if (plain.length !== 3 || !/^task-[a-z0-9]+$/.test(jobId) || !/^req-\d+$/.test(requestId) || !["allow", "deny"].includes(decision)) {
    return deny(ANSWER_SHAPE);
  }
  const hasReply = tail.heredoc.marker !== null;
  // Only a refusal takes a reply. An approval is a bare yes.
  if (decision === "allow" && hasReply) return deny(ANSWER_SHAPE);
  const command = `${head} ${jobId} ${requestId} ${decision}`;
  if (decision === "deny") return { command: hasReply ? `${command}${tail.heredoc.heredocText}\n${followingLines}` : command };

  const job = lookup?.(jobId);
  // Nothing is waiting under that name. Let the command run: it explains, and approves nothing.
  if (!job?.secret || job.pending?.id !== requestId) return { command };
  return {
    command: `${command} --${TOKEN_FLAG} ${job.secret}`,
    decision: "ask",
    reason: [
      `${job.pending.label ?? "The delegate"} is asking for permission to ${job.pending.summary}:`,
      ...shownDetail(job.pending.detail),
      `Approve to let it go ahead, or refuse. (delegate job ${jobId}, ${requestId})`
    ].join("\n")
  };
}

/** `task ...`: pass the conversation's mode on, and put a step up to the user. */
function decideTask({ head, rest, followingLines, hasFollowingLines, mode }) {
  const tail = checkedTail(rest, followingLines, SHAPE);
  if (tail.refusal) return deny(tail.refusal);
  // A --conversation-mode already on the line did not come from the hook, so it is
  // dropped: only the hook may say what mode the conversation is in.
  const kept = withoutFlag(tail.words, CONVERSATION_MODE_FLAG);
  const explicit = flagValue(kept, "permission-mode");

  const known = MODES.includes(mode);
  const rewritten =
    head +
    (known ? ` --${CONVERSATION_MODE_FLAG} ${mode}` : "") +
    kept.map((word) => ` ${word}`).join("") +
    tail.heredoc.heredocText +
    (hasFollowingLines ? `\n${followingLines}` : "");

  const conversation = known ? mode : FALLBACK_MODE;
  if (MODES.includes(explicit) && allowsMoreThan(explicit, conversation)) {
    return {
      command: rewritten,
      decision: "ask",
      reason: `This delegate turn asks for permission mode "${explicit}". The conversation is in "${conversation}" mode, which allows less. Approve only if this turn should be allowed more than the conversation is.`
    };
  }
  return { command: rewritten };
}

/**
 * @param {object} input
 * @param {string} input.command          The Bash command about to run.
 * @param {string} [input.mode]           The conversation's permission mode, as Claude Code reports it.
 * @param {string} input.companionPath    Absolute path of this plugin's companion.mjs.
 * @param {(jobId: string) => ({ secret: string | null, pending: object | null } | null)} [input.lookup]
 *   Reads a job's pending request and secret, for an `answer` command.
 * @returns {null | { command?: string, decision?: "ask" | "deny", reason?: string }}
 *   null to leave the command alone. `command` is the rewritten command to run.
 */
export function decide({ command, mode, companionPath, lookup }) {
  if (!command.includes(SCRIPT_NAME)) return null;
  const lineEnd = command.indexOf("\n");
  const firstLine = lineEnd === -1 ? command : command.slice(0, lineEnd);
  const followingLines = lineEnd === -1 ? "" : command.slice(lineEnd + 1);

  const head = firstLine.match(HEAD);
  if (!head || !samePath(unquote(head[1]), companionPath)) {
    // Not the expected form. If one of the two commands is in there somewhere all the
    // same (after a `cd ... &&`, say), it cannot be checked, so it is not run.
    for (const call of checkedCalls(command)) {
      const shape = call.subcommand === "answer" ? ANSWER_SHAPE : SHAPE;
      if (path.isAbsolute(call.scriptPath)) {
        if (samePath(call.scriptPath, companionPath)) return deny(shape);
      } else if (path.basename(call.scriptPath) === SCRIPT_NAME) {
        // A relative path means whatever directory the shell is in by then, which cannot
        // be known from here. It may well be this plugin's script, so it is not run.
        return deny(`${FULL_PATH}\n${shape}`);
      }
    }
    return null;
  }

  const rest = firstLine.slice(head[0].length);
  return head[2] === "answer"
    ? decideAnswer({ head: head[0], rest, followingLines, lookup })
    : decideTask({ head: head[0], rest, followingLines, hasFollowingLines: lineEnd !== -1, mode });
}
