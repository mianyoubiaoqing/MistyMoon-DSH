import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyWorkPresetProvision,
  previewWorkPresetProvision,
  WorkPresetProvisionError,
} from '../src/index.js'

describe('Work preset provisioner', () => {
  it('requires Owner confirmation for a first provision and refuses to overwrite the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-work-provision-'))
    const dshHome = join(root, 'dsh-home')
    const sourceDirectory = join(root, 'source')
    const nativePresetId = 'mistymoon-work-anchored-standard-v1'
    await mkdir(sourceDirectory, { recursive: true })
    await writeFile(join(sourceDirectory, 'agent.cordis.yml'), '[]\n', 'utf8')
    await writeFile(join(sourceDirectory, 'preset.yml'), 'name: Neutral Work Preset\n', 'utf8')

    const plan = await previewWorkPresetProvision({
      version: 1,
      action: 'install',
      dshHome,
      sourceDirectory,
      nativePresetId,
    })

    expect(plan).toMatchObject({
      version: 1,
      action: 'install',
      status: 'ready',
      nativePresetId,
      requiresOwnerConfirmation: true,
      sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      changes: [{ kind: 'create', path: nativePresetId }],
    })
    await expect(applyWorkPresetProvision(plan, { ownerConfirmed: false }))
      .rejects.toMatchObject({ reason: 'confirmation-required' })

    await applyWorkPresetProvision(plan, { ownerConfirmed: true })
    const targetDirectory = join(dshHome, '.agent-presets', nativePresetId)
    await expect(readFile(join(targetDirectory, 'agent.cordis.yml'), 'utf8')).resolves.toBe('[]\n')

    const blocked = await previewWorkPresetProvision({
      version: 1,
      action: 'install',
      dshHome,
      sourceDirectory,
      nativePresetId,
    })
    expect(blocked).toMatchObject({ status: 'target-exists', changes: [] })
    await expect(applyWorkPresetProvision(blocked, { ownerConfirmed: true }))
      .rejects.toBeInstanceOf(WorkPresetProvisionError)
    await expect(readFile(join(targetDirectory, 'agent.cordis.yml'), 'utf8')).resolves.toBe('[]\n')
  })

  it.each(['upgrade', 'rollback'] as const)(
    'previews a versioned %s without mutating the current preset',
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), `mistymoon-work-${action}-`))
      const dshHome = join(root, 'dsh-home')
      const currentNativePresetId = `mistymoon-work-anchored-standard-${action}-current`
      const nativePresetId = `mistymoon-work-anchored-standard-${action}-target`
      const currentDirectory = join(dshHome, '.agent-presets', currentNativePresetId)
      const sourceDirectory = join(root, 'source')
      await mkdir(currentDirectory, { recursive: true })
      await mkdir(sourceDirectory, { recursive: true })
      await writeFile(join(currentDirectory, 'agent.cordis.yml'), 'old: true\n', 'utf8')
      await writeFile(join(currentDirectory, 'removed.mjs'), 'export const old = true\n', 'utf8')
      await writeFile(join(sourceDirectory, 'agent.cordis.yml'), 'new: true\n', 'utf8')
      await writeFile(join(sourceDirectory, 'added.mjs'), 'export const added = true\n', 'utf8')

      const plan = await previewWorkPresetProvision({
        version: 1,
        action,
        dshHome,
        sourceDirectory,
        nativePresetId,
        currentNativePresetId,
      })

      expect(plan).toMatchObject({
        action,
        status: 'ready',
        changes: [
          { kind: 'retain', path: currentNativePresetId },
          { kind: 'create', path: nativePresetId },
        ],
        fileDifferences: [
          { kind: 'added', path: 'added.mjs' },
          { kind: 'modified', path: 'agent.cordis.yml' },
          { kind: 'removed', path: 'removed.mjs' },
        ],
      })
      await expect(readFile(join(currentDirectory, 'agent.cordis.yml'), 'utf8'))
        .resolves.toBe('old: true\n')
    },
  )
})
