import { expect, test } from 'claude-code/testing'

import { takeOptions } from '../hooks/options'
import { grantFor } from '../hooks/permissions'

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

test('the model and effort come off the first line, and the task is left as it was', async () => {
  const taken = takeOptions('--model gpt-6.2-astra --effort=high\nReview src/auth.ts\n--model inside the task stays')
  expect(taken.model).toBe('gpt-6.2-astra')
  expect(taken.effort).toBe('high')
  expect(taken.task).toBe('Review src/auth.ts\n--model inside the task stays')
  expect(taken.setAside).toEqual([])
})

test('--permission and --sandbox are set aside, and any other option is part of the task', async () => {
  const retired = takeOptions('--permission full-access --sandbox disabled fix it')
  expect(retired.setAside).toEqual(['--permission full-access', '--sandbox disabled'])
  expect(retired.task).toBe('fix it')

  const other = takeOptions('--verbose please explain math.js')
  expect(other.model).toBe(null)
  expect(other.task).toBe('--verbose please explain math.js')
})

test('codexSandbox off takes the sandbox away only where Codex may change things', async () => {
  const off = { codexSandbox: 'off' } as const
  expect(grantFor('codex', 'acceptEdits', off).sandbox).toBe('disabled')
  expect(grantFor('codex', 'auto', off).sandbox).toBe('disabled')
  // Read-only options keep it: plan and dontAsk change nothing, default asks per command.
  expect(grantFor('codex', 'plan', off).sandbox).toBe(null)
  expect(grantFor('codex', 'default', off).sandbox).toBe(null)
  expect(grantFor('codex', 'dontAsk', off).sandbox).toBe(null)
  // full-access has none to take away, and the setting is Codex's alone.
  expect(grantFor('codex', 'bypassPermissions', off).sandbox).toBe(null)
  expect(grantFor('agy', 'acceptEdits', off).sandbox).toBe(null)
  // On, the default, nothing changes.
  expect(grantFor('codex', 'acceptEdits', { codexSandbox: 'on' }).sandbox).toBe(null)
})
