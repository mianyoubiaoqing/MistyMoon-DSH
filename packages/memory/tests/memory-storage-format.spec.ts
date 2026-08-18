import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalArchiveJson,
  inspectArchiveBytes,
  MemoryArchiveStorage,
  type MemoryDomainEvent,
} from '../src/storage/index.js'

const unlimited = { maxArchiveBytes: Number.MAX_SAFE_INTEGER, maxTransactionBytes: Number.MAX_SAFE_INTEGER }

function memory(id: string, sourceMessageId: string): MemoryDomainEvent {
  return {
    schemaVersion: 1,
    id,
    createdAt: '2026-08-18T00:00:00.000Z',
    content: `Neutral format fixture ${id}`,
    visibility: 'personal',
    sourceMessageId,
    status: 'confirmed',
  }
}

async function readyArchive(): Promise<{ path: string, lines: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-format-'))
  const path = join(root, 'memories.jsonl')
  const ids = ['transaction-1', 'transaction-2']
  const storage = await MemoryArchiveStorage.open({
    path,
    createTransactionId: () => ids.shift() ?? 'unexpected-transaction',
    now: () => new Date('2026-08-18T00:00:00.000Z'),
  })
  await storage.transact(() => ({ events: [memory('memory-1', 'source-1')], result: undefined }))
  await storage.transact(() => ({ events: [memory('memory-2', 'source-2')], result: undefined }))
  return { path, lines: (await readFile(path, 'utf8')).trimEnd().split(/\r?\n/u) }
}

describe('memory v2 format inspection', () => {
  it('canonicalizes equivalent key insertion orders to the same digest input', () => {
    const first = { z: 3, nested: { b: 2, a: 1 }, a: ['x', { d: 4, c: 3 }] }
    const second = { a: ['x', { c: 3, d: 4 }], nested: { a: 1, b: 2 }, z: 3 }

    expect(canonicalArchiveJson(first)).toBe(canonicalArchiveJson(second))
    expect(createHash('sha256').update(canonicalArchiveJson(first)).digest('hex'))
      .toBe(createHash('sha256').update(canonicalArchiveJson(second)).digest('hex'))
  })

  it.each([
    {
      name: 'modified transaction',
      issue: 'digest-mismatch',
      damage(lines: string[]): string[] {
        const transaction = JSON.parse(lines[1]!) as { events: Array<{ content: string }> }
        transaction.events[0]!.content = 'Neutral modified fixture'
        return [lines[0]!, JSON.stringify(transaction), lines[2]!]
      },
    },
    {
      name: 'broken previous digest',
      issue: 'broken-previous-digest',
      damage(lines: string[]): string[] {
        const transaction = JSON.parse(lines[1]!) as { previousDigest: string }
        transaction.previousDigest = '0'.repeat(64)
        return [lines[0]!, JSON.stringify(transaction), lines[2]!]
      },
    },
    {
      name: 'deleted interior transaction',
      issue: 'broken-previous-digest',
      damage(lines: string[]): string[] { return [lines[0]!, lines[2]!] },
    },
    {
      name: 'reordered transactions',
      issue: 'broken-previous-digest',
      damage(lines: string[]): string[] { return [lines[0]!, lines[2]!, lines[1]!] },
    },
  ])('classifies a $name', async ({ issue, damage }) => {
    const { lines } = await readyArchive()
    const parsed = inspectArchiveBytes(Buffer.from(`${damage(lines).join('\n')}\n`, 'utf8'), unlimited)

    expect(parsed.inspection).toMatchObject({ state: 'quarantined', issues: [{ code: issue }] })
    expect(JSON.stringify(parsed.inspection)).not.toContain('Neutral format fixture')
  })

  it.each([
    {
      name: 'duplicate id',
      events: [memory('memory-shared', 'source-1'), memory('memory-shared', 'source-2')],
      issue: 'duplicate-id',
    },
    {
      name: 'duplicate source',
      events: [memory('memory-1', 'source-shared'), memory('memory-2', 'source-shared')],
      issue: 'duplicate-source',
    },
    {
      name: 'unknown required event',
      events: [{ schemaVersion: 2, event: 'future-required' } as unknown as MemoryDomainEvent],
      issue: 'unknown-required-event',
    },
  ])('classifies $name without partially publishing it', async ({ events, issue }) => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-domain-issue-'))
    const path = join(root, 'memories.jsonl')
    const storage = await MemoryArchiveStorage.open({ path })

    await expect(storage.transact(() => ({ events, result: undefined })))
      .rejects.toMatchObject({ code: 'MEMORY_ARCHIVE_QUARANTINED' })
    expect(storage.snapshot()?.records).toHaveLength(0)
    expect(MemoryArchiveStorage.open({ path }).then(value => value.inspection()))
      .resolves.toMatchObject({ state: 'quarantined', issues: [{ code: issue }] })
  })

  it('rejects configured archive and transaction size limits before unbounded parsing', async () => {
    const archive = Buffer.from('{}\n'.repeat(20), 'utf8')
    expect(inspectArchiveBytes(archive, { maxArchiveBytes: 10, maxTransactionBytes: 10 }).inspection)
      .toMatchObject({ state: 'quarantined', issues: [{ code: 'archive-too-large' }] })

    const { lines } = await readyArchive()
    const bytes = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
    expect(inspectArchiveBytes(bytes, { maxArchiveBytes: bytes.length, maxTransactionBytes: 16 }).inspection)
      .toMatchObject({ state: 'quarantined', issues: [{ code: 'transaction-too-large' }] })
  })

  it('detects a fully removed tail through the adjacent checkpoint', async () => {
    const { path, lines } = await readyArchive()
    await writeFile(path, `${lines.slice(0, -1).join('\n')}\n`, 'utf8')

    await expect(MemoryArchiveStorage.open({ path }).then(value => value.inspection()))
      .resolves.toMatchObject({ state: 'quarantined', issues: [{ code: 'checkpoint-mismatch' }] })
  })
})
