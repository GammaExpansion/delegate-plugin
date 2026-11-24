import { expect, test } from 'claude-code/testing'

import { takeOptions } from '../hooks/options'
import { askedFor, describe, grantFor } from '../hooks/permissions'

test('each permission mode gives each backend its closest option', async () => {
  expect(grantFor('codex', 'plan')).toEqual({ mode: 'plan', permission: 'read-only', approvals: 'decline', sandbox: null })
  expect(grantFor('agy', 'plan')).toEqual({ mode: 'plan', permission: 'plan', approvals: 'decline', sandbox: null })
  expect(grantFor('codex', 'default')).toEqual({ mode: 'default', permission: 'read-only', approvals: 'ask', sandbox: null })
  expect(grantFor('agy', 'acceptEdits')).toEqual({ mode: 'acceptEdits', permission: 'accept-edits', approvals: 'ask', sandbox: null })
  expect(grantFor('codex', 'auto')).toEqual({ mode: 'auto', permission: 'approve-for-me', approvals: 'decline', sandbox: null })
  expect(grantFor('agy', 'bypassPermissions').permission).toBe('skip-permissions')
  expect(grantFor('codex', 'dontAsk').approvals).toBe('decline')
})

test('a mode that is missing or unknown is taken as default', async () => {
  expect(grantFor('codex', undefined)).toEqual({ mode: 'default', permission: 'read-only', approvals: 'ask', sandbox: null })
  expect(grantFor('agy', 'somethingNew').mode).toBe('default')
  expect(grantFor('agy', 'constructor').mode).toBe('default')
})

/** The options of a prompt whose first line is one the plugin accepts. */
function accepted(text: string) {
  const taken = takeOptions(text)
  if ('error' in taken) throw new Error(taken.error)
  return taken
}

test('the options come off the first line, and the task is left as it was', async () => {
  const taken = accepted('--model gpt-6.2-astra --effort=high --permission full-access --sandbox disabled --resume 841a14cd-0000\nReview src/auth.ts\n--model inside the task stays')
  expect(taken.resume).toBe('841a14cd-0000')
  expect(taken.model).toBe('gpt-6.2-astra')
  expect(taken.effort).toBe('high')
  expect(taken.permission).toBe('full-access')
  expect(taken.sandbox).toBe('disabled')
  expect(taken.task).toBe('Review src/auth.ts\n--model inside the task stays')

  // Only the first line is read: an option on a later line is part of the task.
  const later = accepted('Fix the flag parsing\n--model is ignored here\n--unknown thing')
  expect(later.model).toBe(null)
  expect(later.resume).toBe(null)
  expect(later.task).toBe('Fix the flag parsing\n--model is ignored here\n--unknown thing')
})

test('an option the plugin does not know on the first line is refused, not handed to the delegate', async () => {
  expect(takeOptions('--verbose please explain math.js')).toEqual({
    error: "unknown option --verbose on the prompt's first line. The options are --model, --effort, --permission, --sandbox, --resume. A task that itself begins with two dashes should begin with a word instead.",
  })
  // An option of an earlier version, and misspelt ones, after options that are known.
  expect('error' in takeOptions('--brief-file /tmp/brief.md\nDo what the brief says')).toBe(true)
  expect('error' in takeOptions('--model gpt-6.2-astra --resum 841a14cd\nGo on')).toBe(true)
  expect('error' in takeOptions('--permision default\nReview it')).toBe(true)
  // Two dashes with no value after them are not an option.
  expect(accepted('--\nReview it').task).toBe('--\nReview it')
})

test('a task that asks for more than the mode gives is told apart from one that asks for less', async () => {
  const auto = grantFor('codex', 'auto')
  const full = askedFor('codex', auto, 'full-access', null)
  expect(full).toEqual({ grant: { ...auto, permission: 'full-access', sandbox: null }, wider: true })
  // Without the sandbox is more, even at the same option.
  expect(askedFor('codex', auto, null, 'disabled')).toEqual({ grant: { ...auto, sandbox: 'disabled' }, wider: true })
  // Less, or the same, is not.
  expect(askedFor('codex', auto, 'read-only', null)).toEqual({ grant: { ...auto, permission: 'read-only' }, wider: false })
  expect(askedFor('codex', grantFor('codex', 'bypassPermissions'), 'full-access', 'enabled')).toEqual({
    grant: { ...grantFor('codex', 'bypassPermissions'), sandbox: 'enabled' },
    wider: false,
  })
  // agy has no sandbox unless asked: enabling one is less, never more.
  expect(askedFor('agy', grantFor('agy', 'acceptEdits'), null, 'enabled')).toEqual({
    grant: { ...grantFor('agy', 'acceptEdits'), sandbox: 'enabled' },
    wider: false,
  })
  expect(askedFor('agy', grantFor('agy', 'acceptEdits'), 'skip-permissions', null)).toEqual({
    grant: { ...grantFor('agy', 'acceptEdits'), permission: 'skip-permissions' },
    wider: true,
  })
  if ('grant' in full) expect(describe('codex', full.grant)).toBe('full-access, no sandbox')
})

test('an option the backend lacks, or Codex read-only without its sandbox, is refused', async () => {
  const base = grantFor('codex', 'default')
  expect(askedFor('codex', base, 'auto', null)).toEqual({
    error: 'Codex has no permission option "auto". Its options: read-only, ask-for-approval, approve-for-me, full-access.',
  })
  expect('error' in askedFor('codex', base, null, 'disabled')).toBe(true)
  expect('error' in askedFor('agy', grantFor('agy', 'default'), null, 'maybe')).toBe(true)
  // agy's auto has its sandbox built in, whether the mode gives it or the task asks for it.
  expect('error' in askedFor('agy', grantFor('agy', 'auto'), null, 'disabled')).toBe(true)
  expect('error' in askedFor('agy', grantFor('agy', 'default'), 'auto', 'disabled')).toBe(true)
  expect('error' in askedFor('agy', grantFor('agy', 'auto'), 'accept-edits', 'disabled')).toBe(false)
})
