// The options a prompt may carry on its first line, before the task:
//
//     --model gpt-6.2-astra --effort high --permission full-access --sandbox disabled
//     Build the app and install it on the emulator with adb ...
//
// --model and --effort pick the model. --permission and --sandbox ask for something other
// than what the conversation's permission mode gives (permissions.ts): less is taken as it
// is, and more only once the user allows it. --resume names the backend session to continue,
// by the id a report printed. Only the first line is read. An option there that is not one
// of these is an error, so that a misspelt or outdated one is not handed to the delegate as
// part of its task; the rest of the line, and every line after it, is the task, unchanged.

const OPTION_AT_START = /^[ \t]*--([a-z][a-z-]*)(?:=|[ \t]+)(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/
const NAMES = ['model', 'effort', 'permission', 'sandbox', 'resume'] as const
type Name = (typeof NAMES)[number]

export type Leading = Record<Name, string | null> & { task: string }

export function takeOptions(text: string): Leading | { error: string } {
  const taken: Leading = { model: null, effort: null, permission: null, sandbox: null, resume: null, task: '' }
  const body = text.replace(/^\s+/, '')
  const end = body.indexOf('\n')
  let line = end === -1 ? body : body.slice(0, end)
  const rest = end === -1 ? '' : body.slice(end + 1)
  for (;;) {
    const match = OPTION_AT_START.exec(line)
    if (match === null) break
    const name = NAMES.find(known => known === match[1])
    if (name === undefined) {
      const known = NAMES.map(known => `--${known}`).join(', ')
      return { error: `unknown option --${match[1]} on the prompt's first line. The options are ${known}. A task that itself begins with two dashes should begin with a word instead.` }
    }
    taken[name] = match[2] ?? match[3] ?? match[4] ?? ''
    line = line.slice(match[0].length)
  }
  taken.task = (line.trim() === '' ? rest : `${line.trim()}\n${rest}`).trim()
  return taken
}
