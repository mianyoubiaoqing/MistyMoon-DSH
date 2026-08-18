import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_WORK_MODEL_ROUTE,
  loadWorkModelRouteSettings,
  saveWorkModelRouteSettings,
} from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Work model route settings', () => {
  it('defaults only when absent and replaces a versioned credential-free selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-work-model-settings-'))
    roots.push(root)
    const path = join(root, 'settings', 'work-model.json')

    await expect(loadWorkModelRouteSettings(path)).resolves.toEqual(DEFAULT_WORK_MODEL_ROUTE)
    await saveWorkModelRouteSettings(path, {
      version: 1,
      revision: 2,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
      reasoning: 'max',
      qualification: 'experimental-owner-configured',
    })
    await expect(loadWorkModelRouteSettings(path)).resolves.toMatchObject({
      revision: 2,
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
    })
    await saveWorkModelRouteSettings(path, {
      ...DEFAULT_WORK_MODEL_ROUTE,
      revision: 3,
    })
    await expect(loadWorkModelRouteSettings(path)).resolves.toEqual({
      ...DEFAULT_WORK_MODEL_ROUTE,
      revision: 3,
    })
    expect(await readFile(path, 'utf8')).not.toMatch(/key|credential|baseURL|balance/i)
  })

  it('fails closed for malformed, unknown-field, and mismatched qualification documents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-work-model-settings-invalid-'))
    roots.push(root)
    const path = join(root, 'work-model.json')

    await writeFile(path, '{')
    await expect(loadWorkModelRouteSettings(path)).rejects.toThrow(/malformed/)
    await writeFile(path, JSON.stringify({ ...DEFAULT_WORK_MODEL_ROUTE, secret: 'forbidden' }))
    await expect(loadWorkModelRouteSettings(path)).rejects.toThrow(/unknown or missing/)
    await writeFile(path, JSON.stringify({
      ...DEFAULT_WORK_MODEL_ROUTE,
      provider: 'opencode-go',
    }))
    await expect(loadWorkModelRouteSettings(path)).rejects.toThrow(/qualification/)
  })
})
