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

test('the options come off the first line, and the task is left as it was', async () => {
  const taken = takeOptions('--model gpt-6.2-astra --effort=high --permission full-access --sandbox disabled\nReview src/auth.ts\n--model inside the task stays')
  expect(taken.model).toBe('gpt-6.2-astra')
  expect(taken.effort).toBe('high')
  expect(taken.permission).toBe('full-access')
  expect(taken.sandbox).toBe('disabled')
  expect(taken.task).toBe('Review src/auth.ts\n--model inside the task stays')

  const other = takeOptions('--verbose please explain math.js')
  expect(other.model).toBe(null)
  expect(other.task).toBe('--verbose please explain math.js')

  // Only the first line is read: an option on a later line is part of the task.
  const later = takeOptions('Fix the flag parsing\n--model is ignored here')
  expect(later.model).toBe(null)
  expect(later.task).toBe('Fix the flag parsing\n--model is ignored here')
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
})
