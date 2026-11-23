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
// A task may ask for another option, or another sandbox, on its prompt's first line
// (options.ts). What asks for less than the mode gives is taken as it is; what asks for more
// is put to the user first (register.tsx), for that one turn.
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
  /** "disabled" to run without the option's sandbox, "enabled" to add one; null for the option's own. */
  sandbox: Sandbox
}

export type Sandbox = 'enabled' | 'disabled' | null

export type Settings = { codexSandbox: 'on' | 'off' }

const UNSANDBOXABLE = new Set(['ask-for-approval', 'approve-for-me'])

export function grantFor(backend: Backend, mode: string | undefined, settings: Settings = { codexSandbox: 'on' }): Grant {
  const known = mode !== undefined && Object.hasOwn(MODES, mode) ? mode : 'default'
  const row = MODES[known] ?? { codex: 'read-only', agy: 'default', approvals: 'ask' }
  const permission = row[backend]
  const sandboxOff = backend === 'codex' && settings.codexSandbox === 'off' && UNSANDBOXABLE.has(permission)
  return { mode: known, permission, approvals: row.approvals, sandbox: sandboxOff ? 'disabled' : null }
}

// Each backend's options, from the one that may do least. agy's plan and default rank
// alike: neither edits nor runs a command without asking.
const RANK: Record<Backend, Record<string, number>> = {
  codex: { 'read-only': 0, 'ask-for-approval': 1, 'approve-for-me': 2, 'full-access': 3 },
  agy: { plan: 0, default: 0, 'accept-edits': 1, auto: 2, 'skip-permissions': 3 },
}
const PRODUCT: Record<Backend, string> = { codex: 'Codex', agy: 'Antigravity' }

export const optionsOf = (backend: Backend): string[] => Object.keys(RANK[backend])

/** Whether commands run with no sandbox around them. agy has none unless one is asked for. */
function unsandboxed(backend: Backend, permission: string, sandbox: Sandbox): boolean {
  if (backend === 'agy') return sandbox !== 'enabled'
  if (sandbox === 'disabled') return true
  if (sandbox === 'enabled') return false
  return permission === 'full-access'
}

/** "full-access, no sandbox", "approve-for-me", "auto, sandbox": a grant in a few words. */
export function describe(backend: Backend, grant: Pick<Grant, 'permission' | 'sandbox'>): string {
  if (backend === 'codex') return unsandboxed(backend, grant.permission, grant.sandbox) ? `${grant.permission}, no sandbox` : grant.permission
  return grant.sandbox === 'enabled' ? `${grant.permission}, sandbox` : grant.permission
}

export type Asked = { grant: Grant; wider: boolean } | { error: string }

/**
 * The grant a task asks for with --permission and --sandbox, in place of the mode's, and
 * whether it lets the delegate do more than the mode's: a higher option, or commands run
 * without the sandbox the mode's grant has. Approvals stay the mode's.
 */
export function askedFor(backend: Backend, base: Grant, permission: string | null, sandbox: string | null): Asked {
  let option = base.permission
  if (permission !== null) {
    const name = permission.trim().toLowerCase().replace(/[\s_]+/g, '-')
    if (!Object.hasOwn(RANK[backend], name)) {
      return { error: `${PRODUCT[backend]} has no permission option "${permission}". Its options: ${optionsOf(backend).join(', ')}.` }
    }
    option = name
  }
  let box: Sandbox = base.sandbox
  if (sandbox !== null) {
    const word = sandbox.trim().toLowerCase()
    if (word === 'enabled' || word === 'on') box = 'enabled'
    else if (word === 'disabled' || word === 'off') box = 'disabled'
    else return { error: `Unknown --sandbox "${sandbox}". Use enabled or disabled.` }
  } else if (permission !== null) {
    // Another option comes with its own sandbox, unless the codexSandbox setting takes it away.
    box = backend === 'codex' && base.sandbox === 'disabled' && UNSANDBOXABLE.has(option) ? 'disabled' : null
  }
  if (backend === 'codex' && option === 'read-only' && box === 'disabled') {
    return { error: "Codex's read-only is its sandbox, so it cannot run with --sandbox disabled. Pick another --permission." }
  }
  const rank = RANK[backend]
  const wider =
    (rank[option] ?? 0) > (rank[base.permission] ?? 0) ||
    (unsandboxed(backend, option, box) && !unsandboxed(backend, base.permission, base.sandbox))
  return { grant: { ...base, permission: option, sandbox: box }, wider }
}
