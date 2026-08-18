import type { ResolvedSubagentStartRequest, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  WorkReportValidationError,
  createWorkReportProvider,
  parseWorkReportV1,
} from '../src/index.js'

const validReport = {
  version: 1,
  status: 'completed',
  summary: 'Implemented the neutral fixture.',
  changedFiles: ['src/fixture.ts'],
  checksRun: [{ command: 'pnpm test', status: 'passed', summary: '1 test passed.' }],
  risks: [],
  needsUserAction: [],
  artifacts: [{ kind: 'patch', label: 'fixture patch', content: 'diff --git a/src/fixture.ts b/src/fixture.ts' }],
} as const

function request(): ResolvedSubagentStartRequest {
  return {
    prompt: [{ type: 'text', text: 'Implement the neutral fixture.' }],
  } as unknown as ResolvedSubagentStartRequest
}

function delegate(output: unknown, stopReason = 'completed'): SubagentProvider {
  return {
    name: 'fixture-delegate',
    inheritsParentContext: false,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    async start(received) {
      return {
        id: SessionId('work-report-child'),
        localAgent: undefined,
        result: Promise.resolve({ output, stopReason } as never),
        async dispose() {},
      }
    },
  }
}

describe('WorkReportV1 consumption boundary', () => {
  it('strictly parses the versioned report and rejects extra authority-bearing fields', () => {
    expect(parseWorkReportV1(JSON.stringify(validReport))).toEqual(validReport)
    expect(() => parseWorkReportV1(JSON.stringify({ ...validReport, persona: 'do not expose' })))
      .toThrow(WorkReportValidationError)
    expect(() => parseWorkReportV1(JSON.stringify({ ...validReport, status: 'done' })))
      .toThrow(WorkReportValidationError)
  })

  it('adds the fixed report contract to the child prompt and publishes validated structured data', async () => {
    let receivedPrompt: unknown
    const inner = delegate([{ type: 'text', text: JSON.stringify(validReport) }])
    const originalStart = inner.start
    inner.start = async (received) => {
      receivedPrompt = received.prompt
      return originalStart.call(inner, received)
    }
    const provider = createWorkReportProvider(inner)
    const run = await provider.start(request())

    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: JSON.stringify(validReport) }],
      stopReason: 'completed',
      structured: validReport,
    })
    expect(receivedPrompt).toEqual([
      { type: 'text', text: 'Implement the neutral fixture.' },
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('WorkReportV1'),
      }),
    ])
  })

  it.each([
    { name: 'markdown fencing', output: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(validReport)}\n\`\`\`` }] },
    { name: 'multiple blocks', output: [{ type: 'text', text: JSON.stringify(validReport) }, { type: 'text', text: 'extra' }] },
    { name: 'malformed JSON', output: [{ type: 'text', text: '{"version":1' }] },
    { name: 'non-text content', output: [{ type: 'image', mediaType: 'image/png', data: 'AA==' }] },
  ])('fails closed for completed $name output without echoing it', async ({ output }) => {
    const provider = createWorkReportProvider(delegate(output))
    const run = await provider.start(request())

    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'Work Agent report rejected: invalid WorkReportV1 envelope.' }],
      stopReason: 'error',
    })
  })

  it('preserves a non-completed child result without treating partial output as a report', async () => {
    const partial = [{ type: 'text', text: '{"version":1' }]
    const provider = createWorkReportProvider(delegate(partial, 'max-tokens'))
    const run = await provider.start(request())

    await expect(run.result).resolves.toEqual({ output: partial, stopReason: 'max-tokens' })
  })
})
