import { expect, test } from 'claude-code/testing'

import { takeOptions } from '../hooks/options'
import { grantFor } from '../hooks/permissions'

test('each permission mode gives each backend its closest option', async () => {
  expect(grantFor('codex', 'plan')).toEqual({ mode: 'plan', permission: 'read-only', approvals: 'decline' })
  expect(grantFor('agy', 'plan')).toEqual({ mode: 'plan', permission: 'plan', approvals: 'decline' })
  expect(grantFor('codex', 'default')).toEqual({ mode: 'default', permission: 'read-only', approvals: 'ask' })
  expect(grantFor('agy', 'acceptEdits')).toEqual({ mode: 'acceptEdits', permission: 'accept-edits', approvals: 'ask' })
  expect(grantFor('codex', 'auto')).toEqual({ mode: 'auto', permission: 'approve-for-me', approvals: 'decline' })
  expect(grantFor('agy', 'bypassPermissions').permission).toBe('skip-permissions')
  expect(grantFor('codex', 'dontAsk').approvals).toBe('decline')
})

test('a mode that is missing or unknown is taken as default', async () => {
  expect(grantFor('codex', undefined)).toEqual({ mode: 'default', permission: 'read-only', approvals: 'ask' })
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
