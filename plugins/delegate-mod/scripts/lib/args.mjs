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
