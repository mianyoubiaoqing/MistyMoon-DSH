import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  assertReconstructable,
  finalVoiceRefreshEvents,
  lifecycleRecordEvents,
  loopHarness,
  send,
  turnVoiceEvents,
  waitForIdle,
} from './support/loop-harness.js'
import { ScriptedAdapter, textResponse, toolCallResponse } from './support/mock-llm.js'

// The single permitted legacy fixture: these strings describe rc2 events and
// must never be emitted again by the current implementation.
const LEGACY_FULL_TEXT = 'MistyMoon companion presentation context. This is user-owned context, not a replacement system prompt.\nCompanion identity: Luna.'
const LEGACY_CONTINUATION_TEXT = 'MistyMoon continuation voice reminder. When producing owner-facing prose, keep Luna\'s natural-language voice: warm; plain-spoken.'

function legacyFullMessage(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: LEGACY_FULL_TEXT }],
    source: {
      kind: 'plugin',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      summary: 'MistyMoon RP: companion',
      sections: [{ name: 'mistymoon:roleplay', text: LEGACY_FULL_TEXT }],
    },
  })
}

function legacyContinuationMessage(): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text: LEGACY_CONTINUATION_TEXT }],
    source: {
      kind: 'plugin',
      plugin: 'mistymoon-foundation',
      form: 'snapshot',
      summary: 'MistyMoon RP continuation: companion',
      sections: [{ name: 'mistymoon:roleplay-continuation', text: LEGACY_CONTINUATION_TEXT }],
    },
  })
}

function hasLegacySurface(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'mistymoon-foundation'
    && event.data.source.form === 'snapshot'
    && (event.data.source.sections?.some(section => section.name === 'mistymoon:roleplay') === true
      || event.data.source.sections?.some(section => section.name === 'mistymoon:roleplay-continuation') === true))
}

describe('rc2/legacy session compatibility', () => {
  it('preserves seed events, never re-emits legacy persona messages, and truthfully reports remaining legacy surface', async () => {
    // Build a neutral rc2-style seed with real DSH loop events.
    const seedAdapter = new ScriptedAdapter([
      toolCallResponse('legacy-echo', 'echo', { text: 'legacy seed' }),
      textResponse('legacy seed done'),
    ])
    const seedHarness = await loopHarness(seedAdapter, { foundation: false })
    const seedAgent = seedHarness.ctx.agentLoop.create(SessionId('legacy-seed-source'), { provider: 'mock', model: 'mock' })
    send(seedAgent, 'legacy seed owner message')
    await waitForIdle(seedHarness.ctx, seedAgent)

    seedAgent.session.append('user/message', legacyFullMessage(), { surfaceOp: 'append' })
    seedAgent.session.append('user/message', legacyContinuationMessage(), { surfaceOp: 'append' })
    const seed = structuredClone([...seedAgent.session.events])

    // Resume with Foundation active and run a prepare + final sequence.
    const adapter = new ScriptedAdapter([
      toolCallResponse('legacy-prepare', 'mistymoon_prepare_final_reply', {}),
      textResponse('legacy resumed final reply'),
    ])
    const harness = await loopHarness(adapter, { foundation: true })
    const handle = await harness.ctx.agents.create({
      sessionId: SessionId('legacy-resumed'),
      seed,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent

    send(agent, 'legacy resumed owner message')
    await waitForIdle(harness.ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    // Seed events are byte-preserved and no legacy MistyMoon message is re-emitted.
    expect(agent.session.events.slice(0, seed.length)).toEqual(seed)
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(1)
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(1)
    expect(lifecycleRecordEvents(agent.session.events)).toHaveLength(2)
    const newEvents = agent.session.events.slice(seed.length)
    expect(newEvents.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'mistymoon-foundation'
      && event.data.source.form === 'snapshot'
      && (event.data.source.sections?.some(section => section.name === 'mistymoon:roleplay') === true
        || event.data.source.sections?.some(section => section.name === 'mistymoon:roleplay-continuation') === true))).toBe(false)
    for (const request of adapter.requests) {
      expect(request.system).not.toContain('mistymoon:roleplay-anchor')
    }

    // The old surface still contains legacy persona text; the implementation
    // must not claim strict zero-persona for old sessions.
    expect(hasLegacySurface(seed)).toBe(true)
    expect(agent.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Luna')))).toBe(true)

    const seedStepStarts = seed.filter(event => event.type === 'step/start').length
    for (const [index, request] of adapter.requests.entries()) {
      assertReconstructable(agent.session.events, seedStepStarts + index, request)
    }
  })
})
