import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  createUserMessage,
  LlmRuntime,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { describe, expect, it } from 'vitest'

interface CapturedRequest {
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: Record<string, unknown>
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('DeepSeek capture server did not expose a TCP address')
  }
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function request(
  model: string,
  reasoningEffort: 'high' | 'max',
): GenerateOptions {
  return {
    provider: 'deepseek-official',
    model,
    reasoningEffort: ReasoningEffortId(reasoningEffort),
    system: 'Neutral governed Work Agent.',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Inspect the neutral request fixture.' }],
      source: { kind: 'user' },
    })],
    signal: new AbortController().signal,
  }
}

async function officialRuntime(
  baseURL: string,
  dshHome: string,
  thinking: 'enabled' | 'disabled' = 'enabled',
) {
  const ctx = new Context()
  const fiber = ctx.plugin(LlmRuntime)
  await fiber
  const connection = resolveAdapterOptions({
    apiKeyEnv: 'MISTYMOON_TEST_DEEPSEEK_KEY',
    baseURL,
    thinking,
    reasoningEffort: thinking === 'disabled' ? 'off' : 'high',
  })
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async () => 'neutral-test-key',
    resolveUserId: () => getOrCreateAnonymousUserId({
      env: { DSH_HOME: dshHome },
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    }),
  })
  const unregister = ctx.llm.registerAdapter(['deepseek-official'], adapter)
  return { ctx, fiber, unregister }
}

describe('official DeepSeek request capture through the DSH LLM seam', () => {
  it.each([
    { model: 'deepseek-v4-flash', effort: 'high' as const },
    { model: 'deepseek-v4-flash', effort: 'max' as const },
    { model: 'deepseek-v4-pro', effort: 'max' as const },
  ])('serializes $model/$effort without prompt-authored thinking', async ({ model, effort }) => {
    const captures: CapturedRequest[] = []
    const server = createServer((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.on('end', () => {
        captures.push({
          headers: incoming.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}',
          '',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'))
      })
    })
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-deepseek-capture-'))
    let runtime: Awaited<ReturnType<typeof officialRuntime>> | undefined

    try {
      const baseURL = await listen(server)
      runtime = await officialRuntime(baseURL, dshHome)
      const chunks = await collect(runtime.ctx.llm.stream(request(model, effort)))

      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({
        headers: {
          authorization: 'Bearer neutral-test-key',
          'x-deepseek-harness-user-id': '00000000-0000-4000-8000-000000000001',
        },
        body: {
          model,
          messages: [
            { role: 'system', content: 'Neutral governed Work Agent.' },
            { role: 'user', content: 'Inspect the neutral request fixture.' },
          ],
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: 'enabled' },
          reasoning_effort: effort,
        },
      })
      expect(JSON.stringify(captures[0]?.body)).not.toContain('chain-of-thought')
      expect(JSON.stringify(captures[0]?.body)).not.toContain('step by step')
    } finally {
      runtime?.unregister()
      await runtime?.fiber.dispose()
      if (server.listening) await close(server)
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('fails before transport when the deployment disables thinking', async () => {
    const captures: CapturedRequest[] = []
    const server = createServer((_incoming, response) => {
      captures.push({ headers: {}, body: {} })
      response.writeHead(500).end()
    })
    const dshHome = await mkdtemp(join(tmpdir(), 'mistymoon-deepseek-disabled-'))
    let runtime: Awaited<ReturnType<typeof officialRuntime>> | undefined

    try {
      const baseURL = await listen(server)
      runtime = await officialRuntime(baseURL, dshHome, 'disabled')
      const chunks = await collect(runtime.ctx.llm.stream(request('deepseek-v4-flash', 'max')))

      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } },
      })
      expect(captures).toEqual([])
    } finally {
      runtime?.unregister()
      await runtime?.fiber.dispose()
      if (server.listening) await close(server)
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('fails loudly when the official provider route is missing', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(LlmRuntime)
    await fiber

    try {
      const chunks = await collect(ctx.llm.stream(request('deepseek-v4-flash', 'max')))
      expect(chunks.at(-1)).toMatchObject({
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'NO_ADAPTER' } },
      })
    } finally {
      await fiber.dispose()
    }
  })
})
