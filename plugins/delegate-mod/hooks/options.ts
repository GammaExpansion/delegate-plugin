// The options a prompt may carry on its first line, before the task:
//
//     --model gpt-6.2-astra --effort high --permission full-access --sandbox disabled
//     Build the app and install it on the emulator with adb ...
//
// --model and --effort pick the model. --permission and --sandbox ask for something other
// than what the conversation's permission mode gives (permissions.ts): less is taken as it
// is, and more only once the user allows it. Reading stops at the first thing that is not
// one of these: the rest is the task, unchanged.

const OPTION_AT_START = /^\s*--([a-z][a-z-]*)(?:=|[ \t]+)(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/
const NAMES = ['model', 'effort', 'permission', 'sandbox'] as const
type Name = (typeof NAMES)[number]

export type Leading = Record<Name, string | null> & { task: string }

export function takeOptions(text: string): Leading {
  const taken: Leading = { model: null, effort: null, permission: null, sandbox: null, task: '' }
  let rest = text
  for (;;) {
    const match = OPTION_AT_START.exec(rest)
    if (match === null) break
    const name = NAMES.find(known => known === match[1])
    if (name === undefined) break
    taken[name] = match[2] ?? match[3] ?? match[4] ?? ''
    rest = rest.slice(match[0].length)
  }
  taken.task = rest.trim()
  return taken
}
