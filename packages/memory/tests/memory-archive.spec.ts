import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openMemoryArchive } from '../src/index.js'

describe('companion memory archive', () => {
  it('deduplicates explicit memories by source message and recalls them after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-'))
    const path = join(root, 'memory.jsonl')
    const first = await openMemoryArchive({
      path,
      createId: () => 'memory-1',
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })

    const remembered = await first.observeExplicit({
      sourceMessageId: 'message-1',
      text: '请记住：我喜欢凤凰单丛，暂时不要告诉别人。',
    })
    const duplicate = await first.observeExplicit({
      sourceMessageId: 'message-1',
      text: '请记住：我喜欢凤凰单丛，暂时不要告诉别人。',
    })

    expect(remembered).toMatchObject({
      id: 'memory-1',
      content: '我喜欢凤凰单丛，暂时不要告诉别人。',
      visibility: 'confidential',
      sourceMessageId: 'message-1',
      status: 'confirmed',
    })
    expect(duplicate).toEqual(remembered)

    const reopened = await openMemoryArchive({ path })
    expect(reopened.recall({ query: '喜欢什么茶', limit: 4 })).toEqual([remembered])
  })

  it('keeps forgotten memories out of recall while retaining an auditable record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-forget-'))
    const path = join(root, 'memory.jsonl')
    const archive = await openMemoryArchive({
      path,
      createId: (() => {
        const ids = ['memory-1', 'event-1']
        return () => ids.shift() ?? 'unexpected-id'
      })(),
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })
    await archive.observeExplicit({ sourceMessageId: 'message-1', text: '请记住：我喜欢凤凰单丛。' })

    const forgotten = await archive.forget({ memoryId: 'memory-1', sourceMessageId: 'tool-call-1' })

    expect(forgotten).toMatchObject({ id: 'memory-1', status: 'forgotten' })
    expect(archive.recall({ query: '凤凰单丛' })).toEqual([])
    expect(archive.list({ includeInactive: true })).toEqual([forgotten])
    const reopened = await openMemoryArchive({ path })
    expect(reopened.recall({ query: '凤凰单丛' })).toEqual([])
    expect(reopened.list({ includeInactive: true })).toEqual([forgotten])
  })

  it('replaces a memory atomically and recalls only the current value after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-replace-'))
    const path = join(root, 'memory.jsonl')
    const ids = ['memory-1', 'memory-2']
    const archive = await openMemoryArchive({
      path,
      createId: () => ids.shift() ?? 'unexpected-id',
      now: () => new Date('2026-08-14T10:00:00.000Z'),
    })
    await archive.observeExplicit({ sourceMessageId: 'message-1', text: '请记住：我喜欢红茶。' })

    const replacement = await archive.replace({
      memoryId: 'memory-1',
      sourceMessageId: 'tool-call-2',
      content: '我现在更喜欢凤凰单丛。',
    })

    expect(replacement).toMatchObject({
      id: 'memory-2',
      content: '我现在更喜欢凤凰单丛。',
      status: 'confirmed',
      supersedesMemoryId: 'memory-1',
    })
    expect(archive.recall({ query: '红茶' })).toEqual([])
    expect(archive.recall({ query: '凤凰单丛' })).toEqual([replacement])
    expect(archive.list({ includeInactive: true })).toEqual([
      replacement,
      expect.objectContaining({ id: 'memory-1', status: 'superseded' }),
    ])
    const reopened = await openMemoryArchive({ path })
    expect(reopened.recall({ query: '凤凰单丛' })).toEqual([replacement])
    expect(reopened.list({ includeInactive: true })).toEqual(archive.list({ includeInactive: true }))
  })
})
