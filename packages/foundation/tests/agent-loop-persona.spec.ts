import { CommandId } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { voiceProjectionOf, type VoiceProjection } from '../src/index.js'
import {
  assertReconstructable,
  COMPLETE_PROMPT,
  finalVoiceRefreshEvents,
  lifecycleRecordEvents,
  loopHarness,
  PRESET_PERSONA,
  send,
  turnVoiceEvents,
  waitForIdle,
} from './support/loop-harness.js'
import { ScriptedAdapter, textResponse, toolCallResponse, toolCallsResponse } from './support/mock-llm.js'

const FORBIDDEN_SYSTEM = [
  'MistyMoon',
  'Luna',
  'warm',
  'plain-spoken',
  'roleplay-anchor',
  'companion presentation',
  'final-voice-refresh',
  'turn-voice',
  'continuation',
] as const

function systemViolations(request: { system?: string }, index: number): Array<{ request: number; needle: string }> {
  const violations: Array<{ request: number; needle: string }> = []
  const system = request.system ?? ''
  for (const needle of FORBIDDEN_SYSTEM) {
    if (system.includes(needle)) violations.push({ request: index + 1, needle })
  }
  return violations
}

function requestText(request: { messages: readonly { content: readonly ContentBlock[] }[] }): string {
  const parts: string[] = []
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push(block.text ?? '')
      } else if (block.type === 'tool-result') {
        for (const part of block.content ?? []) {
          if (part.type === 'text') parts.push(part.text ?? '')
        }
      }
    }
  }
  return parts.join('')
}

function projectionCount(request: { messages: readonly { source: unknown }[] }, projection: VoiceProjection): number {
  return request.messages.filter(message => voiceProjectionOf(message.source) === projection).length
}

function projectionMessageIds(request: { messages: readonly { source: unknown; id: string }[] }, projection: VoiceProjection): string[] {
  return request.messages
    .filter(message => voiceProjectionOf(message.source) === projection)
    .map(message => message.id)
}

function sourceTurn(message: { source: unknown }): number | undefined {
  const turn = (message.source as { turn?: unknown }).turn
  return typeof turn === 'number' ? turn : undefined
}

function sectionNames(message: { source: unknown }): string[] {
  const source = message.source as { sections?: readonly { name?: string }[] } | null
  return source?.sections?.map(section => section.name ?? '') ?? []
}

function projectionEvents(events: readonly SessionEvent[], section: string): SessionEvent[] {
  return events.filter(event => event.type === 'user/message'
    && event.data.source !== undefined
    && sectionNames(event.data as { source: unknown }).includes(section))
}

function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (condition()) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${description}`))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe('real DSH Agent Loop with the two-phase profile delivery coordinator', () => {
  it('does not inject a turn-voice capsule after the blank session durably selects the RP Host preset', async () => {
    const adapter = new ScriptedAdapter([textResponse('direct RP Host reply')])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('rp-host-selected-after-creation'), { provider: 'mock', model: 'mock' })
    agent.session.append('agent-preset/selected', { agentPreset: 'mistymoon-rp-host-v1' })

    send(agent, 'RP Host owner message.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(projectionCount(adapter.requests[0]!, 'turn-voice')).toBe(0)
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(0)
  })

  it('keeps one initial profile across requests 1-10 and gives request 11 only the active refresh with empty tools', async () => {
    const script = [
      ...Array.from({ length: 9 }, (_, index) =>
        toolCallResponse(`echo-${index + 1}`, 'echo', { text: `step ${index + 1}` })),
      toolCallResponse('prepare-final', 'mistymoon_prepare_final_reply', {}),
      textResponse('final owner-facing reply'),
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-long'), { provider: 'mock', model: 'mock' })

    send(agent, 'Run the long echo chain, then prepare and deliver the final reply.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(11)
    const capsuleIds = projectionMessageIds(adapter.requests[0]!, 'turn-voice')
    expect(capsuleIds).toHaveLength(1)
    for (let index = 0; index < 10; index++) {
      const request = adapter.requests[index]
      if (request === undefined) throw new Error(`missing request ${index + 1}`)
      expect(systemViolations(request, index)).toEqual([])
      expect(projectionCount(request, 'turn-voice')).toBe(1)
      expect(projectionMessageIds(request, 'turn-voice')).toEqual(capsuleIds)
      expect(projectionCount(request, 'final-voice-refresh')).toBe(0)
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    }
    for (const [index, request] of adapter.requests.entries()) {
      assertReconstructable(agent.session.events, index, request)
    }

    const final = adapter.requests[10]
    expect(final?.tools ?? []).toEqual([])
    expect(systemViolations(final!, 10)).toEqual([])
    expect(projectionCount(final!, 'turn-voice')).toBe(0)
    expect(projectionCount(final!, 'final-voice-refresh')).toBe(1)
    expect(requestText(final!)).toContain('MistyMoon final-voice-refresh context.')
    expect(requestText(final!)).toContain('Speaker label: Luna.')
    expect(requestText(final!)).not.toContain('roleplay-anchor')

    const events = agent.session.events
    expect(turnVoiceEvents(events)).toHaveLength(1)
    expect(finalVoiceRefreshEvents(events)).toHaveLength(1)
    expect(projectionEvents(events, 'mistymoon:turn-voice-superseded')).toHaveLength(1)
    expect(projectionEvents(events, 'mistymoon:final-voice-refresh-consumed')).toHaveLength(1)
    expect(agent.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Luna')))).toBe(false)
  })

  it('rebuilds every provider request from the durable session log', async () => {
    const script = [
      toolCallResponse('rebuild-1', 'echo', { text: 'one' }),
      textResponse('plain completion without prepare'),
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-rebuild'), { provider: 'mock', model: 'mock' })
    send(agent, 'Neutral rebuild task.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    for (const [index, request] of adapter.requests.entries()) {
      assertReconstructable(agent.session.events, index, request)
    }
  })

  it('serves a one-step prepare, expires both surfaces, and mints a fresh capsule for the next owner turn', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('one-prepare', 'mistymoon_prepare_final_reply', {}),
      textResponse('one-step final reply'),
      textResponse('second turn reply'),
    ])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-one-step'), { provider: 'mock', model: 'mock' })

    send(agent, 'Answer as the final reply.')
    await waitForIdle(ctx, agent)
    const firstTurnEnd = agent.session.events.filter(event => event.type === 'turn/end').length
    expect(firstTurnEnd).toBe(1)
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(1)
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(1)
    expect(lifecycleRecordEvents(agent.session.events)).toHaveLength(2)

    send(agent, 'Second owner turn.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    expect(systemViolations(adapter.requests[0]!, 0)).toEqual([])
    expect(adapter.requests[1]?.tools ?? []).toEqual([])
    expect(projectionCount(adapter.requests[1]!, 'final-voice-refresh')).toBe(1)
    expect(requestText(adapter.requests[1]!)).toContain('MistyMoon final-voice-refresh context.')

    const second = adapter.requests[2]
    expect(systemViolations(second!, 2)).toEqual([])
    expect(second?.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    expect(projectionCount(second!, 'turn-voice')).toBe(1)
    expect(projectionCount(second!, 'final-voice-refresh')).toBe(0)
    expect(sourceTurn(second!.messages.find(message =>
      voiceProjectionOf(message.source) === 'turn-voice')!)).toBe(2)
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(2)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-consumed')).toHaveLength(1)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-superseded')).toHaveLength(1)
  })

  it('serves a short direct final with one capsule, one model call, and no prepare', async () => {
    const adapter = new ScriptedAdapter([textResponse('plain completion')])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-skip'), { provider: 'mock', model: 'mock' })

    send(agent, 'Just answer directly.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect(systemViolations(request, 0)).toEqual([])
    expect(projectionCount(request, 'turn-voice')).toBe(1)
    expect(projectionCount(request, 'final-voice-refresh')).toBe(0)
    const ownerIndex = request.messages.findIndex(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Just answer directly.')))
    const voiceIndex = request.messages.findIndex(message => voiceProjectionOf(message.source) === 'turn-voice')
    expect(voiceIndex).toBe(ownerIndex + 1)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'tool/call'
      && event.data.name === 'mistymoon_prepare_final_reply')).toBe(false)
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(1)
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(0)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-consumed')).toHaveLength(1)
    expect(agent.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Luna')))).toBe(false)
  })

  it('projects nothing under /rp off and leaves prepare without a gate', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('off-prepare', 'mistymoon_prepare_final_reply', {}),
      textResponse('off final reply'),
    ])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-off'), { provider: 'mock', model: 'mock' })
    agent.session.append('command/run', {
      commandId: CommandId('off-command'),
      name: 'rp',
      args: 'off',
      source: { kind: 'user' },
    })

    send(agent, 'Prepare a final reply while roleplay is off.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    for (const [index, request] of adapter.requests.entries()) {
      expect(systemViolations(request, index)).toEqual([])
      expect(projectionCount(request, 'turn-voice')).toBe(0)
      expect(projectionCount(request, 'final-voice-refresh')).toBe(0)
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    }
    expect(requestText(adapter.requests[1]!)).toContain('Roleplay is off')
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(0)
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(0)
  })

  it('refuses a prepare call that shares an assistant message with a business tool', async () => {
    const adapter = new ScriptedAdapter([
      toolCallsResponse([
        { rawCallId: 'sibling-echo', name: 'echo', args: { text: 'sibling' } },
        { rawCallId: 'sibling-prepare', name: 'mistymoon_prepare_final_reply', args: {} },
      ]),
      textResponse('after sibling'),
    ])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-sibling'), { provider: 'mock', model: 'mock' })

    send(agent, 'Echo something and prepare at the same time.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    for (const [index, request] of adapter.requests.entries()) {
      expect(systemViolations(request, index)).toEqual([])
      expect(projectionCount(request, 'final-voice-refresh')).toBe(0)
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    }
    expect(projectionCount(adapter.requests[1]!, 'turn-voice')).toBe(1)
    expect(requestText(adapter.requests[1]!)).toContain('echo: sibling')
    expect(requestText(adapter.requests[1]!)).toContain('Final reply preparation refused')
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(0)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-consumed')).toHaveLength(1)
  })

  it('keeps one logged refresh and the empty gate across a provider retry of the final step', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('retry-prepare', 'mistymoon_prepare_final_reply', {}),
      'fail',
      textResponse('retried final reply'),
    ])
    const { ctx } = await loopHarness(adapter, { foundation: true, retryOnce: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-retry'), { provider: 'mock', model: 'mock' })

    send(agent, 'Prepare the final reply, then fail once and retry.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    for (const index of [1, 2]) {
      const request = adapter.requests[index]
      if (request === undefined) throw new Error('missing retry request')
      expect(request.tools ?? []).toEqual([])
      expect(systemViolations(request, index)).toEqual([])
      expect(projectionCount(request, 'final-voice-refresh')).toBe(1)
      expect(projectionCount(request, 'turn-voice')).toBe(0)
    }
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(1)
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(1)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-superseded')).toHaveLength(1)
    expect(projectionEvents(agent.session.events, 'mistymoon:final-voice-refresh-consumed')).toHaveLength(1)
  })

  it('cleans the gate after a user cancel and the next turn starts fresh', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('cancel-prepare', 'mistymoon_prepare_final_reply', {}),
      'hang',
      textResponse('after cancel reply'),
    ])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-cancel'), { provider: 'mock', model: 'mock' })

    const firstIdle = waitForIdle(ctx, agent)
    send(agent, 'Prepare a final reply that will be cancelled.')
    await waitFor(() => adapter.requests.length >= 2 && finalVoiceRefreshEvents(agent.session.events).length === 1, 'final step to start')
    agent.cancel({ kind: 'user' })
    await firstIdle

    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(1)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-superseded')).toHaveLength(1)
    expect(projectionEvents(agent.session.events, 'mistymoon:final-voice-refresh-consumed')).toHaveLength(1)
    expect(agent.session.deriveMessages().some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('Luna')))).toBe(false)

    send(agent, 'Next owner turn after cancel.')
    await waitForIdle(ctx, agent)
    const last = adapter.requests.at(-1)
    expect(systemViolations(last!, 2)).toEqual([])
    expect(last?.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    expect(projectionCount(last!, 'turn-voice')).toBe(1)
    expect(projectionCount(last!, 'final-voice-refresh')).toBe(0)
    expect(sourceTurn(last!.messages.find(message =>
      voiceProjectionOf(message.source) === 'turn-voice')!)).toBe(2)
  })

  it('isolates an armed agent from a second agent running in parallel', async () => {
    const adapter1 = new ScriptedAdapter([
      toolCallResponse('iso-prepare', 'mistymoon_prepare_final_reply', {}),
      'hang',
      textResponse('agent one after cancel'),
    ])
    const adapter2 = new ScriptedAdapter([textResponse('agent two normal reply')])
    const { ctx } = await loopHarness(adapter1, { foundation: true })
    ctx.llm.registerAdapter(['mock2'], adapter2)
    const one = ctx.agentLoop.create(SessionId('final-gate-two-agent-one'), { provider: 'mock', model: 'mock' })
    const two = ctx.agentLoop.create(SessionId('final-gate-two-agent-two'), { provider: 'mock2', model: 'mock' })

    const oneIdle = waitForIdle(ctx, one)
    send(one, 'Prepare and hang for isolation.')
    await waitFor(() => adapter1.requests.length >= 2 && finalVoiceRefreshEvents(one.session.events).length === 1, 'agent one final step')

    send(two, 'Ordinary business turn while agent one is armed.')
    await waitForIdle(ctx, two)
    expect(adapter2.requests).toHaveLength(1)
    expect(systemViolations(adapter2.requests[0]!, 0)).toEqual([])
    expect(adapter2.requests[0]?.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    expect(projectionCount(adapter2.requests[0]!, 'turn-voice')).toBe(1)
    expect(projectionCount(adapter2.requests[0]!, 'final-voice-refresh')).toBe(0)

    one.cancel({ kind: 'user' })
    await oneIdle
  })

  it('keeps complete prompts exact while the final request gets only logged user context', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('complete-prepare', 'mistymoon_prepare_final_reply', {}),
      textResponse('complete final reply'),
    ])
    const { ctx } = await loopHarness(adapter, { foundation: true, complete: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-complete'), { provider: 'mock', model: 'mock' })

    send(agent, 'Complete-prompt final reply task.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[0]!)).toContain('MistyMoon output presentation profile')
    expect(projectionCount(adapter.requests[0]!, 'turn-voice')).toBe(1)
    expect(projectionCount(adapter.requests[1]!, 'turn-voice')).toBe(0)
    for (const [index, request] of adapter.requests.entries()) {
      expect(request.system).toBe(COMPLETE_PROMPT)
      expect(systemViolations(request, index)).toEqual([])
    }
    expect(projectionCount(adapter.requests[0]!, 'final-voice-refresh')).toBe(0)
    expect(requestText(adapter.requests[1]!)).toContain('MistyMoon final-voice-refresh context.')
    expect(adapter.requests[1]?.tools ?? []).toEqual([])
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(1)
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(1)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-superseded')).toHaveLength(1)
    expect(projectionEvents(agent.session.events, 'mistymoon:final-voice-refresh-consumed')).toHaveLength(1)
  })

  it('keeps ordinary Native system prompt and business tools identical to a control group', async () => {
    const foundationScript = [
      toolCallResponse('control-echo', 'echo', { text: 'control' }),
      textResponse('control completion'),
    ]
    const controlScript = [
      toolCallResponse('control-echo', 'echo', { text: 'control' }),
      textResponse('control completion'),
    ]
    const foundationAdapter = new ScriptedAdapter(foundationScript)
    const controlAdapter = new ScriptedAdapter(controlScript)
    const foundation = await loopHarness(foundationAdapter, { foundation: true })
    const control = await loopHarness(controlAdapter, { foundation: false })

    const foundationAgent = foundation.ctx.agentLoop.create(SessionId('native-with-foundation'), { provider: 'mock', model: 'mock' })
    const controlAgent = control.ctx.agentLoop.create(SessionId('native-control'), { provider: 'mock', model: 'mock' })
    send(foundationAgent, 'Native control task.')
    send(controlAgent, 'Native control task.')
    await Promise.all([waitForIdle(foundation.ctx, foundationAgent), waitForIdle(control.ctx, controlAgent)])

    expect(foundationAdapter.requests).toHaveLength(2)
    expect(controlAdapter.requests).toHaveLength(2)
    expect(foundationAdapter.requests[0]?.system).toBe(controlAdapter.requests[0]?.system)
    expect(PRESET_PERSONA).toBe('Neutral preset persona.')
    expect(foundationAdapter.requests[0]?.tools?.filter(tool => tool.name === 'echo'))
      .toEqual(controlAdapter.requests[0]?.tools?.filter(tool => tool.name === 'echo'))
    expect(foundationAdapter.requests[0]?.tools?.filter(tool => tool.name === 'mistymoon_prepare_final_reply')).toHaveLength(1)
    expect(controlAdapter.requests[0]?.tools?.some(tool => tool.name === 'mistymoon_prepare_final_reply')).toBe(false)
    const foundationMessages = foundationAdapter.requests[0]!.messages
    const controlMessages = controlAdapter.requests[0]!.messages
    expect(foundationMessages[0]?.content).toEqual(controlMessages[0]?.content)
    expect(foundationMessages).toHaveLength(controlMessages.length + 1)
    expect(voiceProjectionOf(foundationMessages[1]?.source)).toBe('turn-voice')
  })

  it('finishes a long chain that skips prepare with the initial capsule and no extra model call', async () => {
    const script = [
      ...Array.from({ length: 9 }, (_, index) =>
        toolCallResponse(`skip-echo-${index + 1}`, 'echo', { text: `skip step ${index + 1}` })),
      textResponse('skip final reply'),
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('final-gate-skip-long'), { provider: 'mock', model: 'mock' })

    send(agent, 'Long skip chain owner message.')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(10)
    for (const [index, request] of adapter.requests.entries()) {
      expect(systemViolations(request, index)).toEqual([])
      expect(projectionCount(request, 'turn-voice')).toBe(1)
      expect(projectionCount(request, 'final-voice-refresh')).toBe(0)
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(['echo', 'mistymoon_prepare_final_reply'])
    }
    expect(turnVoiceEvents(agent.session.events)).toHaveLength(1)
    expect(finalVoiceRefreshEvents(agent.session.events)).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'tool/call'
      && event.data.name === 'mistymoon_prepare_final_reply')).toBe(false)
    expect(projectionEvents(agent.session.events, 'mistymoon:turn-voice-consumed')).toHaveLength(1)
  })
})

describe('retention regressions: two-phase profile delivery', () => {
  it('short direct final gets exactly one owner-tail turn-voice after the real owner message', async () => {
    const adapter = new ScriptedAdapter([textResponse('short direct final reply')])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('red-short-direct'), { provider: 'mock', model: 'mock' })
    send(agent, 'Short direct owner message.')
    await waitForIdle(ctx, agent)

    const failures: string[] = []
    if (adapter.requests.length !== 1) {
      failures.push(`request count: expected 1, got ${adapter.requests.length}`)
    }
    const request = adapter.requests[0]
    if (request !== undefined) {
      const voiceIndexes = request.messages
        .map((message, index) => ({ message, index }))
        .filter(entry => sectionNames(entry.message).includes('mistymoon:turn-voice'))
        .map(entry => entry.index)
      if (voiceIndexes.length !== 1) {
        failures.push(`request 1 turn-voice message count: expected 1, got ${voiceIndexes.length}`)
      }
      const ownerIndex = request.messages.findIndex(message => message.content.some(block =>
        block.type === 'text' && block.text.includes('Short direct owner message.')))
      if (voiceIndexes[0] !== ownerIndex + 1) {
        failures.push(`request 1 ordering: owner at ${ownerIndex}, turn-voice at ${voiceIndexes[0] ?? 'absent'}`)
      }
      if (voiceIndexes.length === 1) {
        const voice = request.messages[voiceIndexes[0]!]
        if (voice !== undefined && !voice.content.some(block =>
          block.type === 'text' && block.text.includes('MistyMoon output presentation profile'))) {
          failures.push('request 1 turn-voice message is missing the output presentation rendering')
        }
      }
      if ((request.system ?? '').includes('MistyMoon') || (request.system ?? '').includes('Luna')) {
        failures.push(`request 1 system prompt contains persona text: ${request.system}`)
      }
    }
    const events = agent.session.events
    const turnVoices = projectionEvents(events, 'mistymoon:turn-voice')
    if (turnVoices.length !== 1) {
      failures.push(`logged turn-voice events: expected 1, got ${turnVoices.length}`)
    }
    const consumed = projectionEvents(events, 'mistymoon:turn-voice-consumed')
    if (consumed.length !== 1) {
      failures.push(`logged turn-voice-consumed events: expected 1, got ${consumed.length}`)
    }
    const prepareCalls = events.filter(event => event.type === 'tool/call'
      && (event as { data: { name?: string } }).data.name === 'mistymoon_prepare_final_reply')
    if (prepareCalls.length !== 0) {
      failures.push(`prepare calls: expected 0, got ${prepareCalls.length}`)
    }
    const assistantFinals = events.filter(event => event.type === 'assistant/message')
    if (assistantFinals.length !== 1) {
      failures.push(`assistant finals: expected 1, got ${assistantFinals.length}`)
    }
    expect(failures).toEqual([])
  })

  it('eleven-request long chain keeps one initial profile and one active refresh only on the empty-tool final', async () => {
    const script = [
      ...Array.from({ length: 9 }, (_, index) =>
        toolCallResponse(`red-echo-${index + 1}`, 'echo', { text: `red step ${index + 1}` })),
      toolCallResponse('red-prepare', 'mistymoon_prepare_final_reply', {}),
      textResponse('red long final reply'),
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('red-long-chain'), { provider: 'mock', model: 'mock' })
    send(agent, 'Red long chain owner message.')
    await waitForIdle(ctx, agent)

    const failures: string[] = []
    if (adapter.requests.length !== 11) {
      failures.push(`request count: expected 11, got ${adapter.requests.length}`)
    }
    const firstRequest = adapter.requests[0]
    const firstVoiceIndex = firstRequest?.messages.findIndex(message => sectionNames(message).includes('mistymoon:turn-voice')) ?? -1
    const firstVoiceId = firstVoiceIndex >= 0 ? firstRequest?.messages[firstVoiceIndex]?.id : undefined
    if (firstVoiceIndex < 0) {
      failures.push('request 1 missing mistymoon:turn-voice')
    }
    for (let index = 0; index < 10; index++) {
      const request = adapter.requests[index]
      if (request === undefined) {
        failures.push(`request ${index + 1} missing`)
        continue
      }
      const voiceIndexes = request.messages
        .map((message, messageIndex) => ({ message, messageIndex }))
        .filter(entry => sectionNames(entry.message).includes('mistymoon:turn-voice'))
        .map(entry => entry.messageIndex)
      if (voiceIndexes.length !== 1) {
        failures.push(`request ${index + 1} turn-voice message count: expected 1, got ${voiceIndexes.length}`)
      }
      if (voiceIndexes.length === 1 && request.messages[voiceIndexes[0]!]?.id !== firstVoiceId) {
        failures.push(`request ${index + 1} reuses a different turn-voice message id`)
      }
      const refreshCount = request.messages.filter(message => sectionNames(message).includes('mistymoon:final-voice-refresh')).length
      if (refreshCount !== 0) {
        failures.push(`request ${index + 1} final-voice-refresh count: expected 0, got ${refreshCount}`)
      }
      if ((request.system ?? '').includes('MistyMoon') || (request.system ?? '').includes('Luna')) {
        failures.push(`request ${index + 1} system prompt contains persona text`)
      }
      const tools = (request.tools ?? []).map(tool => tool.name).sort()
      if (JSON.stringify(tools) !== JSON.stringify(['echo', 'mistymoon_prepare_final_reply'])) {
        failures.push(`request ${index + 1} tools: ${JSON.stringify(tools)}`)
      }
    }
    const final = adapter.requests[10]
    if (final !== undefined) {
      const finalTools = (final.tools ?? []).map(tool => tool.name)
      if (finalTools.length !== 0) {
        failures.push(`request 11 tools: expected [], got ${JSON.stringify(finalTools)}`)
      }
      const refreshCount = final.messages.filter(message => sectionNames(message).includes('mistymoon:final-voice-refresh')).length
      if (refreshCount !== 1) {
        failures.push(`request 11 final-voice-refresh count: expected 1, got ${refreshCount}`)
      }
      const turnVoiceCount = final.messages.filter(message => sectionNames(message).includes('mistymoon:turn-voice')).length
      if (turnVoiceCount !== 0) {
        failures.push(`request 11 turn-voice count: expected 0, got ${turnVoiceCount}`)
      }
    } else {
      failures.push('request 11 missing')
    }
    const events = agent.session.events
    const turnVoices = projectionEvents(events, 'mistymoon:turn-voice')
    if (turnVoices.length !== 1) {
      failures.push(`logged turn-voice events: expected 1, got ${turnVoices.length}`)
    }
    const refreshes = projectionEvents(events, 'mistymoon:final-voice-refresh')
    if (refreshes.length !== 1) {
      failures.push(`logged final-voice-refresh events: expected 1, got ${refreshes.length}`)
    }
    const superseded = projectionEvents(events, 'mistymoon:turn-voice-superseded')
    if (superseded.length !== 1) {
      failures.push(`logged turn-voice-superseded events: expected 1, got ${superseded.length}`)
    }
    const refreshConsumed = projectionEvents(events, 'mistymoon:final-voice-refresh-consumed')
    if (refreshConsumed.length !== 1) {
      failures.push(`logged final-voice-refresh-consumed events: expected 1, got ${refreshConsumed.length}`)
    }
    expect(failures).toEqual([])
  })
})

describe('revised red regressions: mutually exclusive output profiles', () => {
  it('long chain neutralizes the initial profile before the sole active refresh', async () => {
    const script = [
      ...Array.from({ length: 9 }, (_, index) =>
        toolCallResponse(`rev-echo-${index + 1}`, 'echo', { text: `rev step ${index + 1}` })),
      toolCallResponse('rev-prepare', 'mistymoon_prepare_final_reply', {}),
      textResponse('revised long final reply'),
    ]
    const adapter = new ScriptedAdapter(script)
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('rev-long-exclusive'), { provider: 'mock', model: 'mock' })
    send(agent, 'Revised long chain owner message.')
    await waitForIdle(ctx, agent)

    const failures: string[] = []
    if (adapter.requests.length !== 11) {
      failures.push(`request count: expected 11, got ${adapter.requests.length}`)
    }
    for (let index = 0; index < 10; index++) {
      const request = adapter.requests[index]
      if (request === undefined) continue
      const activeTurn = projectionCount(request, 'turn-voice')
      const activeRefresh = projectionCount(request, 'final-voice-refresh')
      if (activeTurn !== 1) failures.push(`request ${index + 1} active turn-voice: expected 1, got ${activeTurn}`)
      if (activeRefresh !== 0) failures.push(`request ${index + 1} active refresh: expected 0, got ${activeRefresh}`)
      if ((request.system ?? '').includes('MistyMoon')) failures.push(`request ${index + 1} system contains MistyMoon`)
      const tools = (request.tools ?? []).map(tool => tool.name).sort()
      if (JSON.stringify(tools) !== JSON.stringify(['echo', 'mistymoon_prepare_final_reply'])) {
        failures.push(`request ${index + 1} tools: ${JSON.stringify(tools)}`)
      }
    }
    const final = adapter.requests[10]
    if (final !== undefined) {
      const activeTurn = projectionCount(final, 'turn-voice')
      const activeRefresh = projectionCount(final, 'final-voice-refresh')
      if (activeTurn !== 0) failures.push(`request 11 active turn-voice: expected 0, got ${activeTurn}`)
      if (activeRefresh !== 1) failures.push(`request 11 active refresh: expected 1, got ${activeRefresh}`)
      if (activeTurn + activeRefresh > 1) failures.push(`request 11 active profile total: expected <=1, got ${activeTurn + activeRefresh}`)
      const tools = (final.tools ?? []).map(tool => tool.name)
      if (tools.length !== 0) failures.push(`request 11 tools: expected [], got ${JSON.stringify(tools)}`)
    }
    const events = agent.session.events
    const superseded = projectionEvents(events, 'mistymoon:turn-voice-superseded')
    const refresh = projectionEvents(events, 'mistymoon:final-voice-refresh')
    if (superseded.length !== 1) failures.push(`logged turn-voice-superseded events: expected 1, got ${superseded.length}`)
    if (refresh.length !== 1) failures.push(`logged final-voice-refresh events: expected 1, got ${refresh.length}`)
    if (superseded[0] !== undefined && refresh[0] !== undefined && superseded[0].seq >= refresh[0].seq) {
      failures.push(`superseded seq ${superseded[0].seq} must precede refresh seq ${refresh[0].seq}`)
    }
    expect(failures).toEqual([])
  })

  it('second owner turn keeps only its own active profile and no instructional residue', async () => {
    const adapter = new ScriptedAdapter([
      toolCallResponse('rev-prepare-turn1', 'mistymoon_prepare_final_reply', {}),
      textResponse('revised prepared turn one final'),
      textResponse('revised turn two final'),
    ])
    const { ctx } = await loopHarness(adapter, { foundation: true })
    const agent = ctx.agentLoop.create(SessionId('rev-cross-turn'), { provider: 'mock', model: 'mock' })
    send(agent, 'Revised owner turn one.')
    await waitForIdle(ctx, agent)
    send(agent, 'Revised owner turn two.')
    await waitForIdle(ctx, agent)

    const failures: string[] = []
    const prepared = adapter.requests[1]
    if (prepared !== undefined) {
      const activeTurn = projectionCount(prepared, 'turn-voice')
      const activeRefresh = projectionCount(prepared, 'final-voice-refresh')
      if (activeTurn !== 0) failures.push(`prepared final active turn-voice: expected 0, got ${activeTurn}`)
      if (activeRefresh !== 1) failures.push(`prepared final active refresh: expected 1, got ${activeRefresh}`)
      if (activeTurn + activeRefresh > 1) failures.push(`prepared final active profile total: expected <=1, got ${activeTurn + activeRefresh}`)
    }
    const second = adapter.requests[2]
    if (second !== undefined) {
      const activeTurn = projectionCount(second, 'turn-voice')
      const activeRefresh = projectionCount(second, 'final-voice-refresh')
      if (activeTurn !== 1) failures.push(`request 3 active turn-voice: expected 1, got ${activeTurn}`)
      if (activeRefresh !== 0) failures.push(`request 3 active refresh: expected 0, got ${activeRefresh}`)
      const forbidden = ['no persona', 'ignore persona', 'do not roleplay', 'apply now']
      for (const message of second.messages) {
        const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
        for (const needle of forbidden) {
          if (text.toLowerCase().includes(needle.toLowerCase())) {
            failures.push(`request 3 instructional residue: ${JSON.stringify(needle)} in "${text.slice(0, 80)}"`)
          }
        }
      }
    }
    expect(failures).toEqual([])
  })
})
