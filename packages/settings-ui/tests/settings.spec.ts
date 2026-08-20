import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { initializePersona } from '@mistymoon/dsh-foundation/persona-home'
import { openMemoryArchive, type MemoryAccessContextV1, type MemoryGovernanceService } from '@mistymoon/dsh-memory'
import { RpWorkDelegationRuntime } from '@mistymoon/dsh-work-agent-dsh'
import {
  applyMistyMoonCharacterCard,
  approveMistyMoonCandidate,
  assessMistyMoonCandidate,
  batchMistyMoonCandidates,
  configureMistyMoonWorkModel,
  publishMistyMoonPersona,
  readMistyMoonCandidates,
  readMistyMoonMemory,
  readMistyMoonMemorySource,
  readMistyMoonSettings,
  readMistyMoonWorkModel,
  rejectMistyMoonCandidate,
  reviseMistyMoonCandidates,
  saveMistyMoonSettings,
  previewMistyMoonCharacterCard,
} from '../src/index.js'
import { DEFAULT_CHARACTER_CARD_MAPPING } from '@mistymoon/dsh-foundation/character-card'

const template = join(import.meta.dirname, '..', '..', 'foundation', 'personas', 'template', 'persona.json')
const memoryAccess: MemoryAccessContextV1 = {
  version: 1,
  ownerId: 'owner-fixture',
  authority: 'local-dsh-host-rpc',
  scope: { version: 1, kind: 'companion-reality' },
  channelDisclosure: 'owner-confidential',
  requestIntent: 'explicit-confidential-recall',
}

describe('MistyMoon settings Host API', () => {
  it('saves persona changes as a draft and publishes only on explicit request', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-settings-'))
    await initializePersona({ privateHome: home, templatePath: template })
    const before = await readMistyMoonSettings(home)
    const saved = await saveMistyMoonSettings(home, {
      persona: { ...before.persona, displayName: 'Local Misty' },
      recallLimit: 12,
    })

    expect(saved.persona.displayName).toBe('Local Misty')
    expect(saved.activePersona.displayName).toBe(before.activePersona.displayName)
    expect(saved.hasPersonaDraft).toBe(true)
    expect(saved.personaPreview).toContain('You are Local Misty.')
    expect(saved.recallLimit).toBe(12)
    expect(JSON.parse(await readFile(join(home, 'persona', 'persona.json'), 'utf8')).displayName)
      .toBe(before.activePersona.displayName)
    expect(JSON.parse(await readFile(join(home, 'settings', 'settings.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      recallLimit: 12,
    })

    const published = await publishMistyMoonPersona(home)
    expect(published.activePersona.displayName).toBe('Local Misty')
    expect(published.hasPersonaDraft).toBe(false)
    expect(published.personaVersions).toHaveLength(1)
  })

  it('rejects unknown settings fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-settings-invalid-'))
    await expect(saveMistyMoonSettings(home, {
      persona: {},
      recallLimit: 8,
      path: 'elsewhere',
    })).rejects.toThrow('must contain persona and recallLimit')
  })

  it('previews a card without mutation and applies it only as a persona draft', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-card-settings-'))
    await initializePersona({ privateHome: home, templatePath: template })
    const source = Buffer.from(JSON.stringify({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: { name: 'Imported Example', description: 'A neutral imported fixture.', system_prompt: 'Unsafe by default.' },
    }))
    const request = {
      fileName: 'example.json',
      contentBase64: source.toString('base64'),
      mapping: DEFAULT_CHARACTER_CARD_MAPPING,
    }

    const preview = await previewMistyMoonCharacterCard(home, request)
    expect(preview).toMatchObject({
      source: { fileName: 'example.json', container: 'json' },
      draft: { character: { name: 'Imported Example' } },
      persona: { displayName: 'Imported Example', advancedInstructions: '' },
    })
    expect((await readMistyMoonSettings(home)).hasPersonaDraft).toBe(false)

    const applied = await applyMistyMoonCharacterCard(home, request)
    expect(applied.hasPersonaDraft).toBe(true)
    expect(applied.persona.displayName).toBe('Imported Example')
    expect(applied.activePersona.displayName).not.toBe('Imported Example')
  })

  it('reviews candidates through the same archive used by memory recall', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-candidate-settings-'))
    const ids = [
      'observation-1', 'candidate-1', 'observation-2', 'candidate-2',
      'observation-3', 'memory-1', 'event-1', 'observation-4', 'event-2',
    ]
    const archive = await openMemoryArchive({
      path: join(home, 'memory', 'memories.jsonl'),
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    })
    const approvedCandidate = await archive.propose({
      context: memoryAccess,
      memoryKind: 'summary',
      sourceMessageId: 'proposal-1',
      content: '主人周末会整理书桌。',
      visibility: 'personal',
    })
    const rejectedCandidate = await archive.propose({
      context: memoryAccess,
      memoryKind: 'summary',
      sourceMessageId: 'proposal-2',
      content: '主人每天凌晨四点起床。',
      visibility: 'personal',
    })

    const governance: MemoryGovernanceService = {
      listCandidates: input => archive.listCandidates({ context: memoryAccess, ...input }),
      assessCandidate: input => archive.assessCandidate({ context: memoryAccess, ...input }),
      editCandidate: input => archive.editCandidate({ context: memoryAccess, ...input }),
      mergeCandidates: input => archive.mergeCandidates({ context: memoryAccess, ...input }),
      listGovernanceAudit: input => archive.listGovernanceAudit({ context: memoryAccess, ...input }),
      manage: input => archive.manage({ context: memoryAccess, ...input }),
      sourceView: input => archive.sourceView({ context: memoryAccess, ...input }),
      batchDecide: input => archive.batchDecide({ context: memoryAccess, ...input }),
      approveCandidate: input => archive.approveCandidate({ context: memoryAccess, ...input }),
      rejectCandidate: input => archive.rejectCandidate({ context: memoryAccess, ...input }),
    }

    expect(readMistyMoonCandidates(governance)).toEqual([rejectedCandidate, approvedCandidate])
    await approveMistyMoonCandidate(governance, approvedCandidate.id, 'approve-1')
    await rejectMistyMoonCandidate(governance, rejectedCandidate.id, 'reject-1')

    expect(readMistyMoonCandidates(governance)).toEqual([])
    expect(archive.recall({ context: memoryAccess, query: '周末' })).toEqual([
      expect.objectContaining({ content: '主人周末会整理书桌。', sourceCandidateId: approvedCandidate.id }),
    ])
    expect(archive.recall({ context: memoryAccess, query: '凌晨四点' })).toEqual([])
  })

  it('uses the Memory-owned management facade for search, source, revision, assessment, and batch review', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-memory-management-settings-'))
    const archive = await openMemoryArchive({
      path: join(home, 'memory', 'memories.jsonl'),
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    })
    const candidate = await archive.propose({
      context: memoryAccess,
      sourceMessageId: 'management-source',
      content: '中性设置页候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    const governance: MemoryGovernanceService = {
      listCandidates: input => archive.listCandidates({ context: memoryAccess, ...input }),
      assessCandidate: input => archive.assessCandidate({ context: memoryAccess, ...input }),
      editCandidate: input => archive.editCandidate({ context: memoryAccess, ...input }),
      mergeCandidates: input => archive.mergeCandidates({ context: memoryAccess, ...input }),
      listGovernanceAudit: input => archive.listGovernanceAudit({ context: memoryAccess, ...input }),
      manage: input => archive.manage({ context: memoryAccess, ...input }),
      sourceView: input => archive.sourceView({ context: memoryAccess, ...input }),
      batchDecide: input => archive.batchDecide({ context: memoryAccess, ...input }),
      approveCandidate: input => archive.approveCandidate({ context: memoryAccess, ...input }),
      rejectCandidate: input => archive.rejectCandidate({ context: memoryAccess, ...input }),
    }

    expect(readMistyMoonMemory(governance, { query: '设置页', candidateStatus: 'pending' }).candidates)
      .toEqual([candidate])
    expect(readMistyMoonMemorySource(governance, { entity: 'candidate', id: candidate.id }))
      .toMatchObject({ observation: { sourceId: 'management-source' } })
    expect(assessMistyMoonCandidate(governance, { candidateId: candidate.id }).relationships).toEqual([])

    const edited = await reviseMistyMoonCandidates(governance, 'edit', {
      candidateIds: [candidate.id],
      requestId: 'edit-request',
      content: '中性设置页编辑候选。',
      visibility: 'personal',
      memoryKind: 'summary',
    })
    await expect(batchMistyMoonCandidates(governance, {
      requestId: 'batch-request',
      decisions: [{ candidateId: edited.id, action: 'reject' }],
    })).resolves.toMatchObject({ results: [{ candidateId: edited.id, status: 'succeeded' }] })
    expect(() => readMistyMoonMemory(governance, { ownerId: 'browser-must-not-select-owner' }))
      .toThrow('unknown fields')
  })

  it('lists and saves only credential-free Work models registered in DSH', async () => {
    const llm = {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'opencode-go', name: 'OpenCode Go' },
      ],
      listModels: async (provider: string) => provider === 'opencode-go'
        ? [
            { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
            { provider, id: 'chat-only', name: 'Chat Only' },
          ]
        : [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      resolveCallConfig: async (config: { model: string }) => {
        if (config.model === 'chat-only') throw new Error('UNSUPPORTED_REASONING_EFFORT')
        return config
      },
    }
    const runtime = new RpWorkDelegationRuntime({ llm } as unknown as Context)
    const ctx = { mistymoonWorkDelegation: runtime } as unknown as Context

    const before = await readMistyMoonWorkModel(ctx)
    expect(before.options).toEqual([
      expect.objectContaining({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        qualification: 'qualified-direct',
      }),
      expect.objectContaining({
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        qualification: 'experimental-owner-configured',
      }),
    ])
    expect(JSON.stringify(before)).not.toMatch(/apiKey|credential|baseURL|balance/i)

    await expect(configureMistyMoonWorkModel(ctx, {
      expectedRevision: 1,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      ownerConfirmed: false,
    })).rejects.toThrow(/Owner confirmation/)
    await expect(configureMistyMoonWorkModel(ctx, {
      expectedRevision: 1,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      ownerConfirmed: true,
      apiKey: 'must-not-cross-the-boundary',
    })).rejects.toThrow(/revision, provider, model, and confirmation/)

    await expect(configureMistyMoonWorkModel(ctx, {
      expectedRevision: 1,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      ownerConfirmed: true,
    })).resolves.toMatchObject({
      selection: {
        revision: 2,
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
      },
    })
  })
})
