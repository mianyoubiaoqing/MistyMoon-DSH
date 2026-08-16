import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** One scripted text reply ending with a normal stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (character): StreamChunk => ({ type: 'text-delta', index: 0, text: character })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One scripted tool-call reply with an optional leading text block. */
export function toolCallResponse(rawCallId: string, name: string, args: object, text?: string): StreamChunk[] {
  return toolCallsResponse([{ rawCallId, name, args }], text)
}

/** One scripted reply carrying several tool-call blocks, optionally after text. */
export function toolCallsResponse(
  calls: readonly { rawCallId: string; name: string; args: object }[],
  text?: string,
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  let index = 0
  if (text !== undefined) {
    chunks.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text },
      { type: 'block-end', index, block: { type: 'text', text } },
    )
    index += 1
  }
  for (const call of calls) {
    const callId = CallId(call.rawCallId)
    const argumentsJson = JSON.stringify(call.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: callId, argumentsDelta: argumentsJson.slice(0, 5) },
      { type: 'tool-call-delta', index, id: callId, argumentsDelta: argumentsJson.slice(5) },
      { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: call.name, arguments: argumentsJson } },
    )
    index += 1
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

export type ScriptEntry = StreamChunk[] | 'fail' | 'hang'

/**
 * Deterministic keyless adapter that consumes one scripted response per model
 * call and records every request. `fail` rejects the stream (for retry tests);
 * `hang` yields partial text until the request signal aborts (for cancel tests).
 */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'fail') throw new Error('ScriptedAdapter: scripted failure')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<never>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
