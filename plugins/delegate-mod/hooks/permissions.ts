// What a delegate may do follows the permission mode of the conversation that started it.
// Each mode is matched to the backend option that comes closest, and to whether the
// requests that option does not settle by itself are put to the user:
//
//   mode               Codex              Antigravity        a request beyond it
//   plan               read-only          plan               declined
//   default            read-only          default            the user is asked
//   acceptEdits        ask-for-approval   accept-edits       the user is asked
//   auto               approve-for-me     auto               declined (the backend's own
//                                                            reviewer stands in for Claude
//                                                            Code's classifier)
//   bypassPermissions  full-access        skip-permissions   (nothing is asked)
//   dontAsk            read-only          default            declined
//
// A mode this table does not know is taken as default.
//
// Codex runs its commands in a sandbox. Some work cannot run in one at all (adb and an
// emulator, a build that writes to ~/.gradle), so the plugin setting codexSandbox = off
// takes it away in the two options that let Codex change things, ask-for-approval and
// approve-for-me. Codex then runs commands without asking. The read-only options keep it:
// in plan and dontAsk mode nothing is to change, and in default mode Codex can still ask
// to run one command outside the sandbox, which the user is asked about.

export type Backend = 'codex' | 'agy'
export type Approvals = 'ask' | 'decline'

type Row = { codex: string; agy: string; approvals: Approvals }

const MODES: Record<string, Row> = {
  plan: { codex: 'read-only', agy: 'plan', approvals: 'decline' },
  default: { codex: 'read-only', agy: 'default', approvals: 'ask' },
  acceptEdits: { codex: 'ask-for-approval', agy: 'accept-edits', approvals: 'ask' },
  auto: { codex: 'approve-for-me', agy: 'auto', approvals: 'decline' },
  bypassPermissions: { codex: 'full-access', agy: 'skip-permissions', approvals: 'decline' },
  dontAsk: { codex: 'read-only', agy: 'default', approvals: 'decline' },
}

export type Grant = {
  /** The mode the grant was made for, after an unknown one is taken as default. */
  mode: string
  /** The backend's own permission option. */
  permission: string
  approvals: Approvals
  /** "disabled" when Codex runs this turn without its sandbox; null for the option's own. */
  sandbox: 'disabled' | null
}

export type Settings = { codexSandbox: 'on' | 'off' }

const UNSANDBOXABLE = new Set(['ask-for-approval', 'approve-for-me'])

export function grantFor(backend: Backend, mode: string | undefined, settings: Settings = { codexSandbox: 'on' }): Grant {
  const known = mode !== undefined && Object.hasOwn(MODES, mode) ? mode : 'default'
  const row = MODES[known] ?? { codex: 'read-only', agy: 'default', approvals: 'ask' }
  const permission = row[backend]
  const sandboxOff = backend === 'codex' && settings.codexSandbox === 'off' && UNSANDBOXABLE.has(permission)
  return { mode: known, permission, approvals: row.approvals, sandbox: sandboxOff ? 'disabled' : null }
}
