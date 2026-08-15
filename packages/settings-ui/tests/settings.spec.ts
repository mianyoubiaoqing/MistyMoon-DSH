import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializePersona } from '@mistymoon/dsh-foundation'
import { readMistyMoonSettings, saveMistyMoonSettings } from '../src/index.js'

const template = join(import.meta.dirname, '..', '..', 'foundation', 'personas', 'template', 'persona.json')

describe('MistyMoon settings Host API', () => {
  it('writes private persona and recall settings without exposing a caller-selected path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-settings-'))
    await initializePersona({ privateHome: home, templatePath: template })
    const before = await readMistyMoonSettings(home)
    const saved = await saveMistyMoonSettings(home, {
      persona: { ...before.persona, displayName: 'Local Misty' },
      recallLimit: 12,
    })

    expect(saved.persona.displayName).toBe('Local Misty')
    expect(saved.recallLimit).toBe(12)
    expect(JSON.parse(await readFile(join(home, 'settings', 'settings.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      recallLimit: 12,
    })
  })

  it('rejects unknown settings fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mistymoon-settings-invalid-'))
    await expect(saveMistyMoonSettings(home, {
      persona: {},
      recallLimit: 8,
      path: 'elsewhere',
    })).rejects.toThrow('must contain persona and recallLimit')
  })
})
