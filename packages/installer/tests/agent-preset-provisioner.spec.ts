import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyAgentPresetProvision,
  previewAgentPresetProvision,
} from '../src/index.js'

const RP_PRESET = fileURLToPath(new URL(
  '../../foundation/presets/mistymoon-rp-host-v1/',
  import.meta.url,
))

describe('AgentPresetProvisioner', () => {
  it('previews and installs the RP Host preset only after Owner confirmation', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-rp-preset-'))
    const plan = await previewAgentPresetProvision({
      version: 1,
      action: 'install',
      dshHome,
      sourceDirectory: RP_PRESET,
      nativePresetId: 'mistymoon-rp-host-v1',
    })

    expect(plan).toMatchObject({
      status: 'ready',
      nativePresetId: 'mistymoon-rp-host-v1',
      requiresOwnerConfirmation: true,
    })
    await expect(applyAgentPresetProvision(plan, { ownerConfirmed: false }))
      .rejects.toThrow(/confirmation/i)
    await applyAgentPresetProvision(plan, { ownerConfirmed: true })

    const installed = join(dshHome, '.agent-presets', 'mistymoon-rp-host-v1')
    await expect(readFile(join(installed, 'preset.yml'), 'utf8')).resolves.toContain('MistyMoon RP Host')
    await expect(readFile(join(installed, 'agent.cordis.yml'), 'utf8')).resolves.toContain('mistymoon_code_flash')
  })
})
