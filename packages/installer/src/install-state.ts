import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const PACKAGE_NAME = '@mistymoon/dsh'
const PROFILE_NAME = 'web'
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/
const FINGERPRINT = /^[a-f0-9]{64}$/
const ARCHIVE_NAME = /^mistymoon-dsh(?:-[0-9A-Za-z][0-9A-Za-z.+-]*)?\.tgz$/
const MAX_STATE_BYTES = 64 * 1024

/** One previous version retained for an explicit Owner-confirmed rollback. */
export interface MistyMoonPreviousInstallV1 {
  packageVersion: string
  bundleArchive: string
  bundleFingerprint: string
  rpPresetId: string
  rpPresetFingerprint: string
  workPresetId: string
  workPresetFingerprint: string
}

/** Content-free installer state published only after a complete transaction. */
export interface MistyMoonInstallStateV1 extends MistyMoonPreviousInstallV1 {
  version: 1
  packageName: '@mistymoon/dsh'
  dshVersion: string
  profileName: 'web'
  previous?: MistyMoonPreviousInstallV1
}

/** Stable location of the installer-owned state below a DSH Home. */
export function installStatePath(dshHome: string): string {
  return join(dshHome, 'mistymoon', 'install-state.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const actual = Object.keys(value).sort()
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key))
    && actual.every(key => allowed.has(key))
}

function hasInstalledVersionFields(value: Record<string, unknown>): boolean {
  return typeof value.packageVersion === 'string' && VERSION.test(value.packageVersion)
    && typeof value.bundleArchive === 'string' && ARCHIVE_NAME.test(value.bundleArchive)
    && typeof value.bundleFingerprint === 'string' && FINGERPRINT.test(value.bundleFingerprint)
    && typeof value.rpPresetId === 'string' && PRESET_ID.test(value.rpPresetId)
    && typeof value.rpPresetFingerprint === 'string' && FINGERPRINT.test(value.rpPresetFingerprint)
    && typeof value.workPresetId === 'string' && PRESET_ID.test(value.workPresetId)
    && typeof value.workPresetFingerprint === 'string' && FINGERPRINT.test(value.workPresetFingerprint)
}

function isInstalledVersion(value: unknown): value is MistyMoonPreviousInstallV1 {
  return isRecord(value) && hasExactKeys(value, [
    'packageVersion',
    'bundleArchive',
    'bundleFingerprint',
    'rpPresetId',
    'rpPresetFingerprint',
    'workPresetId',
    'workPresetFingerprint',
  ]) && hasInstalledVersionFields(value)
}

function parseInstallState(value: unknown): MistyMoonInstallStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version',
    'packageName',
    'packageVersion',
    'bundleArchive',
    'bundleFingerprint',
    'dshVersion',
    'profileName',
    'rpPresetId',
    'rpPresetFingerprint',
    'workPresetId',
    'workPresetFingerprint',
  ], ['previous'])
    || value.version !== 1
    || value.packageName !== PACKAGE_NAME
    || value.profileName !== PROFILE_NAME
    || typeof value.dshVersion !== 'string'
    || !VERSION.test(value.dshVersion)
    || !hasInstalledVersionFields(value)
    || (value.previous !== undefined && !isInstalledVersion(value.previous))) {
    throw new TypeError('MistyMoon install state is invalid or uses an unsupported version.')
  }
  return value as unknown as MistyMoonInstallStateV1
}

/** Read and strictly validate installer state without inspecting private product data. */
export async function readMistyMoonInstallState(
  dshHome: string,
): Promise<MistyMoonInstallStateV1 | undefined> {
  let serialized: string
  try {
    serialized = await readFile(installStatePath(dshHome), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
    throw new TypeError('MistyMoon install state exceeds the supported size.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch (error) {
    throw new TypeError('MistyMoon install state is not valid JSON.', { cause: error })
  }
  return parseInstallState(parsed)
}

/** Atomically publish validated installer state after all other writes succeed. */
export async function writeMistyMoonInstallState(
  dshHome: string,
  state: MistyMoonInstallStateV1,
): Promise<void> {
  const validated = parseInstallState(state)
  const target = installStatePath(dshHome)
  await mkdir(dirname(target), { recursive: true })
  const staging = `${target}.staging-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(staging, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(staging, target)
  } finally {
    if (handle !== undefined) await handle.close()
    await rm(staging, { force: true })
  }
}
