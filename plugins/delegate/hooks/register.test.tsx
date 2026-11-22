// The mod's tools against a stand-in for scripts/companion.mjs. Run with:
//   claude plugin test plugins/delegate
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Ran = { argv: readonly string[]; stdin?: string }

const running = (doing: string | null) =>
  JSON.stringify({ state: 'running', job: 'task-1', backend: 'codex', agent: 'Codex Agent (gpt-test)', elapsedMs: 1200, session: null, worktree: null, doing })
/** What the model reads of a call's answer: the engine's text, or the hook's own result. */
const said = (answer: { text?: string; result?: unknown }) => answer.text ?? String(answer.result)

const done = (text: string) =>
  JSON.stringify({ state: 'done', job: 'task-1', backend: 'codex', agent: 'Codex Agent (gpt-test)', elapsedMs: 5000, session: 'thread-1', worktree: null, status: 'completed', text })

/**
 * Stands for the engine beneath the mod: registrations succeed, and each run of the
 * companion script is answered with the next of `outputs` and recorded in `ran`.
 */
function engine(
  on: On,
  outputs: (string | { fails: string })[],
  exit: { code: number; stderr: string } = { code: 0, stderr: '' },
): { ran: Ran[]; tools: string[]; prompts: string[] } {
  const ran: Ran[] = []
  const tools: string[] = []
  const prompts: string[] = []
  on('tool.register', (_$, e) => {
    tools.push(`mcp__delegate__${e.name}`)
    return { value: { tool: `mcp__delegate__${e.name}` } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('process.run', (_$, e) => {
    ran.push({ argv: e.argv.slice(2), ...(e.init?.stdin === undefined ? {} : { stdin: e.init.stdin }) })
    const next = e.argv[2] === 'cancel' ? 'Cancelled task-1.' : (outputs.shift() ?? done('(nothing left)'))
    // A scripted failure of this one run, or the exit every run has.
    const ends = typeof next === 'string' ? exit : { code: 2, stderr: `[delegate] ${next.fails}\n` }
    const answered = ends.code === 0 && typeof next === 'string' ? `${next}\n` : ''
    return { value: { exitCode: ends.code, stdout: answered, stderr: ends.stderr, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  return { ran, tools, prompts }
}

test('the tools are registered when the session starts', async ($, on) => {
  const { tools } = engine(on, [])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(tools.sort()).toEqual(['mcp__delegate__agy', 'mcp__delegate__codex', 'mcp__delegate__wait'])
})

test('a call runs the task through the script and returns the answer', async ($, on) => {
  const { ran } = engine(on, [running(null), running('ran npm test'), done('[delegate] Codex Agent · completed\nsession: thread-1\n\nall done')])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const answer = await $.tool.call({ tool: 'mcp__delegate__codex', task: '--permission full-access\nReview src/a.ts', permission: 'read-only', model: 'gpt-test' })

  expect(said(answer)).toContain('all done')
  // The task goes on stdin, whole: a first line that looks like options stays part of it.
  expect(ran[0]?.stdin).toBe('--permission full-access\nReview src/a.ts')
  expect(ran[0]?.argv).toEqual([
    'run', '--backend', 'codex', '--json', '--verbatim', '--max-wait-sec', '20', '--settle-sec', '1',
    '--permission', 'read-only', '--model', 'gpt-test',
  ])
  expect(ran.slice(1).map(one => one.argv.slice(0, 3))).toEqual([['wait', 'task-1', '--json'], ['wait', 'task-1', '--json']])
})

test('a follow-up passes the session on, and agy gets its own backend', async ($, on) => {
  const { ran } = engine(on, [done('ok')])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__delegate__agy', task: 'Now apply the first fix', session: 'thread-9' })
  expect(ran[0]?.argv.slice(0, 3)).toEqual(['run', '--backend', 'agy'])
  expect(ran[0]?.argv).toContain('--resume')
  expect(ran[0]?.argv[ran[0].argv.indexOf('--resume') + 1]).toBe('thread-9')
})

test('an empty task starts nothing', async ($, on) => {
  const { ran } = engine(on, [])
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const answer = await $.tool.call({ tool: 'mcp__delegate__codex', task: '   ' })
  expect(answer.isError).toBe(true)
  expect(ran.length).toBe(0)
})

test('what the script refuses comes back as the call\'s error', async ($, on) => {
  engine(on, [], { code: 2, stderr: '[delegate] Session thread-1 is busy: job task-0 is still running on it.\n' })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const answer = await $.tool.call({ tool: 'mcp__delegate__codex', task: 'Go on', session: 'thread-1' })
  expect(answer.isError).toBe(true)
  expect(answer.text).toContain('Session thread-1 is busy')
})

test('a background call returns at once, and wait collects its result', async ($, on) => {
  const { ran, prompts } = engine(on, [running(null), done('the answer')])
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const started = await $.tool.call({ tool: 'mcp__delegate__codex', task: 'Long job', background: true })
  expect(said(started)).toContain('running in the background · task-1')
  expect(ran.length).toBe(1)

  const collected = await $.tool.call({ tool: 'mcp__delegate__wait', job: 'task-1' })
  expect(said(collected)).toBe('the answer')

  // Collected once: the follower hands nothing over again.
  await clock.advance(10_000)
  expect(prompts).toEqual([])
})

test('a background job nobody waits for is handed over once it ends', async ($, on) => {
  const { prompts } = engine(on, [running(null), running('still going'), done('late answer')])
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__delegate__agy', task: 'Long job', background: true })

  await clock.advance(5_000)
  expect(prompts).toEqual([])
  await clock.advance(5_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Background delegate job task-1 has ended.')
  expect(prompts[0]).toContain('late answer')

  await clock.advance(20_000)
  expect(prompts.length).toBe(1)
})

const ROW = {
  plugin: 'delegate',
  component: 'ToolUse',
  requestId: 'toolu_1',
  props: { tool_use_id: 'toolu_1', tool: 'mcp__delegate__codex', input: { task: 'Review' }, isRunning: true, isErrored: false, isInterrupted: false },
} as const

test('while a call runs, a line under its row says what the delegate does, on every surface', async ($, on) => {
  on('state.get', () => ({
    value: { value: { job: 'task-1', agent: 'Codex Agent (gpt-test)', elapsedMs: 75_000, doing: 'ran npm test (exit 1)' }, version: 1 },
  }))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...ROW, surface })
    const line = await ui.find({ type: 'Text', text: /Codex Agent/ })
    expect(line?.text).toBe('  Codex Agent (gpt-test) · 1m 15s · ran npm test (exit 1)')
    await ui.unmount()
  }
})

test('a finished call, or another tool, keeps the engine\'s row alone', async ($, on) => {
  on('state.get', () => ({
    value: { value: { job: 'task-1', agent: 'Codex Agent (gpt-test)', elapsedMs: 1000, doing: null }, version: 1 },
  }))
  const over = await $.ui.mount({ ...ROW, props: { ...ROW.props, isRunning: false }, surface: 'desktop' })
  expect(await over.find({ type: 'Text', text: /Codex Agent/ })).toBeUndefined()
  await over.unmount()
  const other = await $.ui.mount({ ...ROW, props: { ...ROW.props, tool: 'Bash' }, surface: 'desktop' })
  expect(await other.find({ type: 'Text', text: /Codex Agent/ })).toBeUndefined()
  await other.unmount()
})

test('one failed look at a background job is not its end', async ($, on) => {
  const { prompts } = engine(on, [running(null), { fails: 'a passing hiccup' }, done('got there')])
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__delegate__codex', task: 'Long job', background: true })

  await clock.advance(5_000)
  expect(prompts).toEqual([])
  await clock.advance(5_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('got there')
})
