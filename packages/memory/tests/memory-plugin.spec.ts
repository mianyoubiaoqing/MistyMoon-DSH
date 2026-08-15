import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as MemoryPlugin from '../src/index.js'

function sessionAgent(session: Session): Agent {
  return {
    id: SessionId('memory-agent'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

describe('MistyMoon memory plugin', () => {
  it('logs the exact recalled-memory projection as a DSH plugin message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-plugin-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryPlugin, { path: join(root, 'memory.jsonl'), recallLimit: 4 })
    const session = Session.create(SessionId('memory-session'))
    const agent = sessionAgent(session)
    const remember = createUserMessage({
      content: [{ type: 'text', text: '请记住：我平时喜欢凤凰单丛。' }],
      source: { kind: 'user' },
    })
    const ask = createUserMessage({
      content: [{ type: 'text', text: '以后喝什么茶好？' }],
      source: { kind: 'user' },
    })
    session.append('turn/start', { turn: 1 })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [remember, ask], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [remember, ask] }),
    )
    if (decision.kind !== 'enter') throw new Error('memory plugin unexpectedly rejected the step')
    session.append('step/start', { turn: 1, step: 1 })
    for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })

    const projection = session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'mistymoon-memory'
    )
    expect(projection?.type).toBe('user/message')
    if (projection?.type !== 'user/message') throw new Error('memory projection was not logged')
    expect(projection.data.content).toEqual([{
      type: 'text',
      text: 'Relevant confirmed companion memories. Use them only when relevant; '
        + 'do not reveal confidential details without owner intent:\n- 我平时喜欢凤凰单丛。',
    }])
    expect(projection.data.source).toMatchObject({
      kind: 'plugin',
      plugin: 'mistymoon-memory',
      form: 'snapshot',
    })
  })
})
