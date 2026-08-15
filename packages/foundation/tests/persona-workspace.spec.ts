import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discardPersonaDraft,
  previewPersonaDraft,
  publishPersonaDraft,
  readPersonaWorkspace,
  rollbackPersona,
  savePersona,
  savePersonaDraft,
} from '../src/index.js'

function persona(displayName: string) {
  return {
    schemaVersion: 2,
    kind: 'mistymoon.persona',
    displayName,
    identity: {
      summary: 'A neutral test companion.', relationship: 'Supports the owner.',
      familiarRelationship: 'Uses shared verified context.', strangerRelationship: 'Does not assume familiarity.',
    },
    style: { tone: ['plain'], instructions: 'Answer naturally.', avoid: ['fabrication'] },
    advancedInstructions: '', referenceDialogs: [],
    responseBudgets: {
      brief: { targetCharacters: 40, maxOutputTokens: 100 },
      normal: { targetCharacters: 200, maxOutputTokens: 500 },
      deep: { targetCharacters: 800, maxOutputTokens: 1600 },
    },
    boundaries: { privateByDefault: true, requireApprovalForExternalActions: true },
  } as const
}

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mistymoon-persona-workspace-'))
  await savePersona(join(root, 'persona', 'persona.json'), persona('Active'))
  return root
}

describe('persona workspace', () => {
  it('keeps drafts inert until explicit publication and archives the old active persona', async () => {
    const root = await home()
    await savePersonaDraft(root, persona('Draft'))

    expect((await readPersonaWorkspace(root)).active.displayName).toBe('Active')
    expect(await previewPersonaDraft(root)).toContain('You are Draft.')

    await publishPersonaDraft(root)
    const workspace = await readPersonaWorkspace(root)
    expect(workspace.active.displayName).toBe('Draft')
    expect(workspace.draft).toBeUndefined()
    expect(workspace.versions).toEqual([expect.objectContaining({ displayName: 'Active', reason: 'publish' })])
  })

  it('rejects publication after an out-of-band active change', async () => {
    const root = await home()
    await savePersonaDraft(root, persona('Draft'))
    await savePersona(join(root, 'persona', 'persona.json'), persona('Changed'))

    await expect(publishPersonaDraft(root)).rejects.toThrow(/active persona changed/)
    expect((await readPersonaWorkspace(root)).active.displayName).toBe('Changed')
  })

  it('rolls back through immutable history and preserves the replaced active version', async () => {
    const root = await home()
    await savePersonaDraft(root, persona('Published'))
    await publishPersonaDraft(root)
    const [old] = (await readPersonaWorkspace(root)).versions
    if (old === undefined) throw new Error('expected archived persona')

    await rollbackPersona(root, old.id)
    const workspace = await readPersonaWorkspace(root)
    expect(workspace.active.displayName).toBe('Active')
    expect(workspace.versions).toHaveLength(2)
    expect(workspace.versions.some(version => version.displayName === 'Published' && version.reason === 'rollback')).toBe(true)
  })

  it('requires draft disposal before rollback and removes only the draft', async () => {
    const root = await home()
    await savePersonaDraft(root, persona('Published'))
    await publishPersonaDraft(root)
    const [old] = (await readPersonaWorkspace(root)).versions
    if (old === undefined) throw new Error('expected archived persona')
    await savePersonaDraft(root, persona('Unpublished'))

    await expect(rollbackPersona(root, old.id)).rejects.toThrow(/discard the current persona draft/)
    await discardPersonaDraft(root)
    expect(JSON.parse(await readFile(join(root, 'persona', 'persona.json'), 'utf8')).displayName).toBe('Published')
  })
})
