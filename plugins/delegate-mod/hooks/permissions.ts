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
}

export function grantFor(backend: Backend, mode: string | undefined): Grant {
  const known = mode !== undefined && Object.hasOwn(MODES, mode) ? mode : 'default'
  const row = MODES[known] ?? { codex: 'read-only', agy: 'default', approvals: 'ask' }
  return { mode: known, permission: row[backend], approvals: row.approvals }
}
