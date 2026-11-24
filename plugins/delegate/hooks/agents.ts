// The two agent types, as Claude sees them in its list of subagents. Their model is never
// called: the turn.step hook answers every model request of their loops (register.tsx).

import type { Backend } from './permissions'

export const BACKENDS: readonly Backend[] = ['codex', 'agy']

/** How a delegate is shown while it works and in its report. */
export const AGENT_NAME: Record<Backend, string> = { codex: 'Codex Agent', agy: 'Gemini Agent' }

/** The product, for a question put to the user (at most 12 characters). */
export const PRODUCT: Record<Backend, string> = { codex: 'Codex', agy: 'Antigravity' }

const agentType = (backend: Backend) => `delegate:${backend}`

export function backendOfType(type: string | undefined): Backend | undefined {
  return BACKENDS.find(backend => agentType(backend) === type)
}

const SHARED = (who: string, idHint: string) =>
  [
    `One instance is one conversation with ${who}: continue it with SendMessage to follow up or to answer a question it asked, and start several to run several side by side.`,
    `${who} sees only the prompt, never this conversation: give it the goal, the paths, what is already known, what must not change, and what to return.`,
    `To pick a model, put --model <id> on the prompt's first line (${idHint}); the delegate models tool lists the ids. Left out, ${who} uses its own default, and a continued conversation keeps the model it had.`,
    `Every report has a "session:" line, the id of the conversation on ${who}'s side. To go on with a conversation from an earlier Claude session, start a new instance with --resume <that id> on the first line; write it only when the user or the project's notes give the id. A first line with an option the plugin does not know is refused.`,
    `What ${who} may do follows this conversation's permission mode: in default and accept-edits mode the user is asked about anything more, and in other modes it is declined and listed in the report. Only when the user asks for it, the first line may also carry --permission <option> and --sandbox enabled|disabled: less than the mode gives is taken as it is, more only once the user allows it in a question, for that turn.`,
    `The result is ${who}'s report: a headline with the model, outcome and permission, its session id, anything declined, then its answer. It is another model's work: weigh it and check it against the code.`,
  ].join(' ')

const FALLBACK_PROMPT = [
  'This agent type is run by the delegate plugin, which answers every turn of it itself.',
  'If you are reading this, the plugin did not take this turn.',
  'Do not use any tool and do not attempt the task.',
  'Reply only: "The delegate plugin did not run this turn. Check that it is enabled; the transcript names any error."',
].join(' ')

export const AGENT_SPECS: Record<Backend, { name: string; description: string; prompt: string }> = {
  codex: {
    name: 'codex',
    description: [
      "Runs a task on OpenAI Codex, another vendor's coding agent, and returns its answer.",
      "Codex runs OpenAI's GPT models, which go by names such as Astra, Sol, Terra, Luna and Codex Spark, as in gpt-6.2-astra.",
      'Use it whenever the user asks for Codex, GPT or one of those models, however small the task, or when a second opinion from another vendor\'s model is worth the wait. Do not pick it on your own for small tasks.',
      SHARED('Codex', 'and --effort <level> for its reasoning effort'),
      'Start the call\'s description with "Codex Agent", then the task in a few words.',
    ].join(' '),
    prompt: FALLBACK_PROMPT,
  },
  agy: {
    name: 'agy',
    description: [
      "Runs a task on Google Antigravity (agy), another vendor's coding agent, and returns its answer.",
      "Antigravity runs Google's Gemini models, which go by names such as Neon, Carbon, Argon, Hydrogen and Flash.",
      'Use it whenever the user asks for Antigravity, agy, Gemini or one of those models, however small the task, or when a second opinion from another vendor\'s model is worth the wait. Do not pick it on your own for small tasks.',
      SHARED('Antigravity', 'an id ends in its thinking level, as in gemini-4-neon-high'),
      'Start the call\'s description with "Gemini Agent", then the task in a few words.',
    ].join(' '),
    prompt: FALLBACK_PROMPT,
  },
}
