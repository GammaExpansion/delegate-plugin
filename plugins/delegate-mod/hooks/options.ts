// The options a prompt may carry on its first line, before the task:
//
//     --model gpt-6.2-astra --effort high
//     Review the change in src/auth.ts ...
//
// Only the model and the effort are chosen this way. What a delegate may do follows the
// conversation's permission mode, so --permission and --sandbox, which earlier versions
// took, are read and set aside with a note. Reading stops at the first thing that is not
// one of these: the rest is the task, unchanged.

const OPTION_AT_START = /^\s*--([a-z][a-z-]*)(?:=|[ \t]+)(?:"([^"\n]*)"|'([^'\n]*)'|(\S+))/
const RETIRED = new Set(['permission', 'sandbox'])

export type Leading = {
  model: string | null
  effort: string | null
  /** Options that are no longer taken, as written: "--permission read-only". */
  setAside: string[]
  task: string
}

export function takeOptions(text: string): Leading {
  const taken: Leading = { model: null, effort: null, setAside: [], task: '' }
  let rest = text
  for (;;) {
    const match = OPTION_AT_START.exec(rest)
    if (match === null) break
    const name = match[1] ?? ''
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (name === 'model') taken.model = value
    else if (name === 'effort') taken.effort = value
    else if (RETIRED.has(name)) taken.setAside.push(`--${name} ${value}`)
    else break
    rest = rest.slice(match[0].length)
  }
  taken.task = rest.trim()
  return taken
}
