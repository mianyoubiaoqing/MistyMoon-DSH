import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as MemoryPlugin from '../src/index.js'

const signal = new AbortController().signal

async function execute(ctx: Context, name: string, args: unknown, callId: string): Promise<ToolExecutionResult> {
  return ctx.tools.execute({ signal, callId: CallId(callId), name, arguments: args })
}

function value(result: ToolExecutionResult): unknown {
  if (result.isError) throw new Error(`expected successful memory tool result: ${JSON.stringify(result.content)}`)
  expect(result.isError).toBe(false)
  return result.value
}

describe('MistyMoon memory tools', () => {
  it('lets the owner list, replace, and forget memories through DSH tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-tools-'))
    const path = join(root, 'memories.jsonl')
    const archive = await MemoryPlugin.openMemoryArchive({ path, createId: () => 'memory-1' })
    await archive.observeExplicit({ sourceMessageId: 'message-1', text: '请记住：我喜欢红茶。' })
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })

    const listed = value(await execute(ctx, 'memory_list', { query: '红茶' }, 'call-list'))
    expect(listed).toEqual({
      memories: [expect.objectContaining({ id: 'memory-1', content: '我喜欢红茶。', status: 'confirmed' })],
    })

    const replaced = value(await execute(ctx, 'memory_replace', {
      memoryId: 'memory-1',
      content: '我现在更喜欢凤凰单丛。',
    }, 'call-replace')) as { memory: { id: string } }
    expect(replaced).toEqual({
      memory: expect.objectContaining({ content: '我现在更喜欢凤凰单丛。', status: 'confirmed' }),
    })

    const forgotten = value(await execute(ctx, 'memory_forget', {
      memoryId: replaced.memory.id,
    }, 'call-forget'))
    expect(forgotten).toEqual({
      memory: expect.objectContaining({ id: replaced.memory.id, status: 'forgotten' }),
    })

    expect(value(await execute(ctx, 'memory_list', {}, 'call-list-final'))).toEqual({ memories: [] })
  })

  it('requires an explicit owner review before a proposed memory becomes active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mistymoon-memory-review-tools-'))
    const path = join(root, 'memories.jsonl')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemoryPlugin, { path, recallLimit: 4 })

    const proposed = value(await execute(ctx, 'memory_candidate_propose', {
      content: '主人通常在周末整理书桌。',
      visibility: 'personal',
    }, 'call-propose')) as { candidate: { id: string } }
    expect(proposed).toEqual({
      candidate: expect.objectContaining({ content: '主人通常在周末整理书桌。', status: 'pending' }),
    })
    expect(value(await execute(ctx, 'memory_candidate_list', {}, 'call-candidate-list'))).toEqual({
      candidates: [expect.objectContaining({ id: proposed.candidate.id, status: 'pending' })],
    })
    expect(value(await execute(ctx, 'memory_list', { query: '周末' }, 'call-memory-list'))).toEqual({ memories: [] })

    const approved = value(await execute(ctx, 'memory_candidate_approve', {
      candidateId: proposed.candidate.id,
    }, 'call-approve'))
    expect(approved).toEqual({
      memory: expect.objectContaining({ content: '主人通常在周末整理书桌。', status: 'confirmed' }),
    })
    expect(value(await execute(ctx, 'memory_candidate_list', {}, 'call-candidate-list-final'))).toEqual({ candidates: [] })
    expect(value(await execute(ctx, 'memory_list', { query: '周末' }, 'call-memory-list-final'))).toEqual({
      memories: [expect.objectContaining({ content: '主人通常在周末整理书桌。' })],
    })
  })
})
