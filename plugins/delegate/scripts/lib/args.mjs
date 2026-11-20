// Tiny argv parser: `--flag`, `--key value`, `--key=value`, and `--` to end options.

/**
 * @param {string[]} argv
 * @param {{ booleans?: string[], values?: string[] }} spec
 * @returns {{ options: Record<string, string | boolean>, positionals: string[] }}
 */
export function parseArgs(argv, { booleans = [], values = [] } = {}) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (booleans.includes(name)) {
      options[name] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
      continue;
    }
    if (values.includes(name)) {
      const value = eq === -1 ? argv[(i += 1)] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`Missing value for --${name}.`);
      options[name] = value;
      continue;
    }
    throw new Error(`Unknown option --${name}.`);
  }
  return { options, positionals };
}

// `--name value` or `--name=value` at the very start of a text. A value is one word, or
// several inside quotes.
const OPTION_AT_START = /^\s*--([a-z][a-z-]*)(?:=|[ \t]+)(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/;

/**
 * Take the options written at the top of a request, as in
 *
 *     --permission read-only --model gpt-6.2-astra
 *     Review the change in src/auth.ts ...
 *
 * Whoever writes the request sets the options there, and whoever passes the request on
 * does not have to touch them. Reading stops at the first thing that is not an option;
 * the rest is the task. An option that is not in `names` is an error, so that a
 * misspelt one is not silently handed to the delegate as part of its task.
 *
 * @param {string} text
 * @param {string[]} names
 * @returns {{ options: Record<string, string>, body: string }}
 */
export function takeLeadingOptions(text, names) {
  const options = {};
  let rest = text;
  for (;;) {
    const match = rest.match(OPTION_AT_START);
    if (!match) break;
    const name = match[1];
    if (!names.includes(name)) {
      throw new Error(
        `Unknown option --${name} at the top of the request. The options that go there: ${names.map((known) => `--${known}`).join(", ")}.`
      );
    }
    options[name] = match[2] ?? match[3] ?? match[4];
    rest = rest.slice(match[0].length);
  }
  return { options, body: rest.trim() };
}
