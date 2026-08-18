import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolve } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import {
  WorkActivationBusyError,
  WorkActivationGate,
  WorkActivationRoleError,
  createExclusiveWorkPresetProvider,
} from '../src/index.js'

function parent(id: string, delegationDepth = 0, cwd = resolve('fixture-workspace-shared')): Agent {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: 0,
    id: sessionId,
    createdAt: 1,
    ...(delegationDepth === 0 ? {} : { origin: 'subagent' as const }),
    delegationDepth,
    agentPreset: delegationDepth === 0 ? 'mistymoon-rp-host-v1' : 'mistymoon-work-anchored-standard-v1',
    cwd,
  })
  return { id: SessionId(id), session } as unknown as Agent
}

function request(agent: Agent): ResolvedSubagentStartRequest {
  return {
    parent: agent,
    prompt: 'Neutral bounded task.',
    descriptor: {
      version: 1,
      provider: 'fixture',
      mode: 'one-shot',
      task: 'Neutral bounded task.',
    },
    signal: new AbortController().signal,
  } as unknown as ResolvedSubagentStartRequest
}

describe('exclusive Work activation provider', () => {
  it('enforces a star topology and one foreground activation per RP Host until dispose', async () => {
    const pending: Array<{ resolve: () => void }> = []
    let runs = 0
    const delegate: SubagentProvider = {
      name: 'delegate-fixture',
      inheritsParentContext: false,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      async start(): Promise<SubagentRun> {
        runs++
        let resolve!: () => void
        const result = new Promise<{ output: []; stopReason: 'completed' }>((done) => {
          resolve = () => done({ output: [], stopReason: 'completed' })
        })
        pending.push({ resolve })
        return {
          id: SessionId(`child-${runs}`),
          localAgent: undefined,
          result,
          async dispose() { await result },
        }
      },
    }
    const provider = createExclusiveWorkPresetProvider({
      name: 'mistymoon-work-fixture',
      expectedParentPreset: 'mistymoon-rp-host-v1',
      resolveProvider: () => delegate,
    })
    const firstParent = parent('parent-1')
    const secondParent = parent('parent-2')
    const first = await provider.start(request(firstParent))

    await expect(provider.start(request(firstParent))).rejects.toBeInstanceOf(WorkActivationBusyError)
    const independent = await provider.start(request(secondParent))
    await expect(provider.start(request(parent('child-parent', 1))))
      .rejects.toBeInstanceOf(WorkActivationRoleError)

    pending[0]!.resolve()
    await first.result
    await expect(provider.start(request(firstParent))).rejects.toBeInstanceOf(WorkActivationBusyError)
    await first.dispose()
    const next = await provider.start(request(firstParent))

    pending[1]!.resolve()
    pending[2]!.resolve()
    await Promise.all([independent.dispose(), next.dispose()])
    expect(runs).toBe(3)
  })

  it('shares the serialization gate across Flash and Pro provider tools', async () => {
    let release!: () => void
    const result = new Promise<{ output: []; stopReason: 'completed' }>((resolve) => {
      release = () => resolve({ output: [], stopReason: 'completed' })
    })
    const delegate: SubagentProvider = {
      name: 'shared-delegate',
      inheritsParentContext: false,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      async start() {
        return { id: SessionId('shared-child'), localAgent: undefined, result, async dispose() { await result } }
      },
    }
    const gate = new WorkActivationGate()
    const make = (name: string) => createExclusiveWorkPresetProvider({
      name,
      expectedParentPreset: 'mistymoon-rp-host-v1',
      gate,
      resolveProvider: () => delegate,
    })
    const flash = make('mistymoon-work-flash')
    const pro = make('mistymoon-work-pro')
    const host = parent('shared-parent')
    const run = await flash.start(request(host))

    await expect(pro.start(request(host))).rejects.toBeInstanceOf(WorkActivationBusyError)
    release()
    await run.dispose()
  })

  it('serializes different RP Hosts that target the same workspace lease', async () => {
    let release!: () => void
    const result = new Promise<{ output: []; stopReason: 'completed' }>((resolve) => {
      release = () => resolve({ output: [], stopReason: 'completed' })
    })
    const delegate: SubagentProvider = {
      name: 'workspace-delegate',
      inheritsParentContext: false,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      async start() {
        return { id: SessionId('workspace-child'), localAgent: undefined, result, async dispose() { await result } }
      },
    }
    const gate = new WorkActivationGate()
    const provider = createExclusiveWorkPresetProvider({
      name: 'mistymoon-work-workspace',
      expectedParentPreset: 'mistymoon-rp-host-v1',
      gate,
      leaseKey: request => request.parent.session.header.cwd!.toLowerCase(),
      resolveProvider: () => delegate,
    })
    const run = await provider.start(request(parent('workspace-host-1')))

    await expect(provider.start(request(parent('workspace-host-2'))))
      .rejects.toBeInstanceOf(WorkActivationBusyError)
    const independent = await provider.start(request(parent('other-host', 0, resolve('fixture-workspace-other'))))

    release()
    await Promise.all([run.dispose(), independent.dispose()])
  })
})
