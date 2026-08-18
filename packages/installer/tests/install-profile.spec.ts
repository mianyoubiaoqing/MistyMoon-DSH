import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { dumpProfile, installProfile, packProfileBundle, resolvePreviewHome, smokeProfile } from '../src/index.js'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
let sharedBundleArchive: string
let sharedInstalledHome: string

beforeAll(async () => {
  const bundleRoot = await mkdtemp(join(tmpdir(), 'mistymoon-installer-bundle-'))
  sharedBundleArchive = await packProfileBundle({
    workspaceRoot,
    outputPath: join(bundleRoot, 'mistymoon-dsh.tgz'),
  })
  sharedInstalledHome = await mkdtemp(join(tmpdir(), 'mistymoon-dsh-shared-home-'))
  await installProfile({ workspaceRoot, dshHome: sharedInstalledHome, bundleArchivePath: sharedBundleArchive })
}, 180_000)

describe('resolvePreviewHome', () => {
  it('uses an explicit private home before the dedicated Windows data directory', () => {
    expect(resolvePreviewHome({
      env: {
        LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local',
        MISTYMOON_DSH_HOME: 'D:\\MistyPrivate',
      },
      homeDirectory: 'C:\\Users\\Owner',
      platform: 'win32',
    })).toBe('D:\\MistyPrivate')

    expect(resolvePreviewHome({
      env: { LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local' },
      homeDirectory: 'C:\\Users\\Owner',
      platform: 'win32',
    })).toBe('C:\\Users\\Owner\\AppData\\Local\\MistyMoon\\dsh')
  })
})

describe('installProfile', () => {
  it('installs the MistyMoon bundle through DSH profile management', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-dsh-home-'))

    const result = await installProfile({ workspaceRoot, dshHome, bundleArchivePath: sharedBundleArchive })

    expect(result).toEqual({
      dshHome,
      dshVersion: '0.1.0-rc.7',
      profileDir: join(dshHome, 'profiles', 'web'),
    })
    const manifest = JSON.parse(await readFile(join(result.profileDir, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.name).toBe('dsh-profile-web')
    expect(manifest.dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      '@mistymoon/dsh',
    ])
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@mistymoon/dsh'])
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'cordis.patch.yml'), 'utf8'))
      .resolves.toContain("name: '@mistymoon/dsh/foundation'")
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'packages', 'identity', 'lib', 'index.js'), 'utf8'))
      .resolves.toContain('mistymoon-identity')
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'packages', 'memory', 'lib', 'index.js'), 'utf8'))
      .resolves.toContain('mistymoon-memory')
    await expect(readFile(join(result.profileDir, 'node_modules', '@mistymoon', 'dsh', 'packages', 'work-agent-dsh', 'lib', 'index.js'), 'utf8'))
      .resolves.toContain('createFreshWorkActivation')

    const ownerPatch = '# owner override\n[]\n'
    const personaPath = join(dshHome, 'mistymoon', 'persona', 'persona.json')
    await writeFile(join(result.profileDir, 'cordis.patch.yml'), ownerPatch, 'utf8')
    await mkdir(join(dshHome, 'mistymoon', 'persona'), { recursive: true })
    await writeFile(personaPath, '{"owner":"private"}\n', 'utf8')

    await installProfile({ workspaceRoot, dshHome, bundleArchivePath: sharedBundleArchive })

    await expect(readFile(join(result.profileDir, 'cordis.patch.yml'), 'utf8')).resolves.toBe(ownerPatch)
    await expect(readFile(personaPath, 'utf8')).resolves.toBe('{"owner":"private"}\n')
  }, 240_000)
})

describe('dumpProfile', () => {
  it('is parsed by the repository-pinned DSH runtime', async () => {
    const output = await dumpProfile({ workspaceRoot, dshHome: sharedInstalledHome })

    expect(output).toContain('id: mistymoon-foundation')
    expect(output).toContain('id: mistymoon-identity')
    expect(output).toContain("name: '@mistymoon/dsh/foundation'")
  }, 120_000)
})

describe('smokeProfile', () => {
  it('activates the packed foundation through DSH without binding a web server', async () => {
    const output = await smokeProfile({ workspaceRoot, dshHome: sharedInstalledHome })

    expect(output).toContain('Usage: dsh --profile web')
    const persona = JSON.parse(await readFile(join(sharedInstalledHome, 'mistymoon', 'persona', 'persona.json'), 'utf8')) as {
      kind?: string
    }
    expect(persona.kind).toBe('mistymoon.persona')
  }, 120_000)
})
