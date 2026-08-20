import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as Identity from '../packages/identity/lib/index.js'
import * as Foundation from '../packages/foundation/lib/index.js'
import * as Memory from '../packages/memory/lib/index.js'
import * as MemoryMaintenance from '../packages/memory/lib/maintenance.js'
import * as WorkAgent from '../packages/work-agent/lib/index.js'
import * as WorkAgentDsh from '../packages/work-agent-dsh/lib/index.js'

// dsh-agent-loop is a Foundation test dependency, not a root dependency. Resolve
// it from the built Foundation package's own dependency graph.
const foundationUrl = pathToFileURL(join(process.cwd(), 'packages/foundation/lib/index.js')).href
const foundationRequire = createRequire(foundationUrl)
const AgentRegistry = (await import('@deepseek-ai/dsh-agent')).default
const AgentLoop = (await import(pathToFileURL(foundationRequire.resolve('@deepseek-ai/dsh-agent-loop')).href)).default

if (typeof WorkAgent.SharedBaselineRegistry !== 'function'
  || typeof WorkAgent.WorkPresetResolver !== 'function'
  || typeof WorkAgent.CompatibilityGate !== 'function'
  || typeof WorkAgent.prepareWorkActivationPublication !== 'function'
  || typeof WorkAgent.configuredWorkRouteId !== 'function') {
  throw new Error('built Work Agent contract exports are incomplete')
}
if (typeof WorkAgentDsh.createFreshWorkActivation !== 'function'
  || typeof WorkAgentDsh.createFixedWorkPresetProvider !== 'function'
  || typeof WorkAgentDsh.createGovernedWorkPresetProvider !== 'function'
  || typeof WorkAgentDsh.loadWorkModelRouteSettings !== 'function'
  || typeof WorkAgentDsh.saveWorkModelRouteSettings !== 'function') {
  throw new Error('built DSH Work Agent adapter exports are incomplete')
}
if (typeof Identity.DshOwnerEligibilityService !== 'function') {
  throw new Error('built Identity service export is missing')
}
if (typeof Memory.openMemoryArchive !== 'function'
  || typeof MemoryMaintenance.inspectMemoryArchive !== 'function'
  || typeof MemoryMaintenance.planMemoryArchiveMaintenance !== 'function') {
  throw new Error('built Memory storage or maintenance exports are incomplete')
}

class ScriptedAdapter extends LlmAdapter {
  requests = []
  constructor(script) {
    super()
    this.script = script
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }
  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('built smoke adapter script exhausted')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const textResponse = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  ...Array.from(text, character => ({ type: 'text-delta', index: 0, text: character })),
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const toolCallResponse = (rawCallId, name, args) => {
  const callId = CallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const NEUTRAL_PERSONA = {
  schemaVersion: 2,
  kind: 'mistymoon.persona',
  displayName: 'Luna',
  identity: {
    summary: 'A steady companion who values precise recollection.',
    relationship: 'Continue shared work without inventing shared history.',
    familiarRelationship: 'Refer only to shared, disclosable work.',
    strangerRelationship: 'Be polite without assuming familiarity.',
  },
  style: {
    tone: ['warm', 'plain-spoken'],
    instructions: 'Keep casual chat concise and technical work complete.',
    avoid: ['false certainty'],
  },
  advancedInstructions: 'Admit uncertainty directly.',
  referenceDialogs: [],
  responseBudgets: {
    brief: { targetCharacters: 40, maxOutputTokens: 100 },
    normal: { targetCharacters: 200, maxOutputTokens: 500 },
    deep: { targetCharacters: 800, maxOutputTokens: 1600 },
  },
  boundaries: { privateByDefault: true, requireApprovalForExternalActions: true },
}

async function freshHome(label) {
  const home = await mkdtemp(join(tmpdir(), `mistymoon-built-${label}-`))
  await mkdir(join(home, 'persona'), { recursive: true })
  await writeFile(join(home, 'persona', 'persona.json'), `${JSON.stringify(NEUTRAL_PERSONA)}\n`, 'utf8')
  return home
}

async function makeContext(adapter, home) {
  const ctx = new Context()
  await ctx.plugin((await import('@deepseek-ai/dsh-llm')).default)
  await ctx.plugin((await import('@deepseek-ai/dsh-session')).default)
  await ctx.plugin(SystemPrompt, { persona: 'Neutral built smoke preset.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Identity, { ownerId: 'owner-fixture' })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'Echo the given text.',
    parameters: { text: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `echo: ${String(args.text)}` }]
    },
  }))
  const fiber = await ctx.plugin(Foundation, { home, defaultRoleplayMode: 'companion' })
  return { ctx, fiber }
}

function waitForIdle(ctx, agent) {
  return new Promise((resolve, reject) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
    setTimeout(() => reject(new Error('built smoke timed out waiting for idle')), 10_000)
  })
}

function send(agent, text) {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: `rpc-${text}` },
  }))
}

const requestText = (request) => request.messages.flatMap(message => message.content)
  .flatMap(block => block.type === 'text' ? [block.text] : block.type === 'tool-result' ? (block.content ?? []).flatMap(part => part.type === 'text' ? [part.text] : []) : [])
  .join('')

function projectionCount(request, projection) {
  return request.messages.filter(message => Foundation.voiceProjectionOf(message.source) === projection).length
}

function eventsWithProjection(agent, projection) {
  return agent.session.events.filter(event => event.type === 'user/message'
    && Foundation.voiceProjectionOf(event.data.source) === projection).length
}

function assertSystemClean(request, label) {
  if ((request.system ?? '').includes('MistyMoon') || (request.system ?? '').includes('Luna')) {
    throw new Error(`${label} leaked persona into the system prompt`)
  }
  if ((request.system ?? '').includes('mistymoon:roleplay-anchor')) {
    throw new Error(`${label} still registers a persona system-prompt section`)
  }
}

// Direct short: one capsule, one request, one final, expiry.
{
  const home = await freshHome('direct')
  const adapter = new ScriptedAdapter([textResponse('built short final')])
  const { ctx } = await makeContext(adapter, home)
  const agent = ctx.agentLoop.create(SessionId('built-smoke-direct'), { provider: 'mock', model: 'mock' })
  send(agent, 'Built smoke direct owner message.')
  await waitForIdle(ctx, agent)

  if (adapter.requests.length !== 1) throw new Error(`built direct smoke made ${adapter.requests.length} requests instead of 1`)
  const request = adapter.requests[0]
  assertSystemClean(request, 'built direct smoke')
  if (projectionCount(request, 'turn-voice') !== 1) throw new Error('built direct smoke did not log one turn-voice profile')
  if (projectionCount(request, 'final-voice-refresh') !== 0) throw new Error('built direct smoke leaked a final refresh')
  if (!requestText(request).includes('MistyMoon output presentation profile')) throw new Error('built direct smoke profile text missing')
  if (eventsWithProjection(agent, 'turn-voice') !== 1) throw new Error('built direct smoke profile event count is not one')
  if (eventsWithProjection(agent, 'turn-voice-consumed') !== 1) throw new Error('built direct smoke profile was not consumed')
}

// Long: one capsule, business tools, sole prepare, one refresh, empty-tool final, cleanup.
{
  const home = await freshHome('long')
  const adapter = new ScriptedAdapter([
    toolCallResponse('built-echo', 'echo', { text: 'built' }),
    toolCallResponse('built-prepare', 'mistymoon_prepare_final_reply', {}),
    textResponse('built final reply'),
  ])
  const { ctx } = await makeContext(adapter, home)
  const agent = ctx.agentLoop.create(SessionId('built-smoke-long'), { provider: 'mock', model: 'mock' })
  send(agent, 'Built smoke business task.')
  await waitForIdle(ctx, agent)

  if (adapter.requests.length !== 3) throw new Error(`built long smoke made ${adapter.requests.length} requests instead of 3`)
  for (const [index, request] of adapter.requests.entries()) assertSystemClean(request, `built long smoke request ${index + 1}`)
  for (const index of [0, 1]) {
    const request = adapter.requests[index]
    if (projectionCount(request, 'turn-voice') !== 1) throw new Error(`built long smoke request ${index + 1} is missing its single capsule`)
    if (projectionCount(request, 'final-voice-refresh') !== 0) throw new Error(`built long smoke request ${index + 1} leaked a refresh`)
    if (JSON.stringify((request.tools ?? []).map(tool => tool.name).sort()) !== JSON.stringify(['echo', 'mistymoon_prepare_final_reply'])) {
      throw new Error(`built long smoke request ${index + 1} has wrong tools`)
    }
  }
  const final = adapter.requests[2]
  if (projectionCount(final, 'turn-voice') !== 0) throw new Error('built long smoke final still has an active initial profile')
  if (projectionCount(final, 'final-voice-refresh') !== 1) throw new Error('built long smoke final is missing its single active refresh')
  if ((final.tools ?? []).length !== 0) throw new Error('built long smoke final still exposes tools')
  if (!requestText(final).includes('MistyMoon final-voice-refresh context.') || !requestText(final).includes('Luna')) {
    throw new Error('built long smoke final request is missing the refresh voice')
  }
  if (eventsWithProjection(agent, 'turn-voice') !== 1 || eventsWithProjection(agent, 'final-voice-refresh') !== 1) {
    throw new Error('built long smoke voice events are not exactly-once')
  }
  if (eventsWithProjection(agent, 'turn-voice-superseded') !== 1 || eventsWithProjection(agent, 'final-voice-refresh-consumed') !== 1) {
    throw new Error('built long smoke did not neutralize both profiles')
  }
  if (agent.session.deriveMessages().some(message => message.content.some(block =>
    block.type === 'text' && block.text.includes('Luna')))) {
    throw new Error('built long smoke persona text leaked past the final turn')
  }
}

// Off: zero persona projection.
{
  const home = await freshHome('off')
  const adapter = new ScriptedAdapter([textResponse('built off final')])
  const { ctx } = await makeContext(adapter, home)
  const agent = ctx.agentLoop.create(SessionId('built-smoke-off'), { provider: 'mock', model: 'mock' })
  agent.session.append('command/run', { commandId: 'built-off-command', name: 'rp', args: 'off', source: { kind: 'user' } })
  send(agent, 'Built smoke off owner message.')
  await waitForIdle(ctx, agent)

  if (adapter.requests.length !== 1) throw new Error(`built off smoke made ${adapter.requests.length} requests instead of 1`)
  const request = adapter.requests[0]
  assertSystemClean(request, 'built off smoke')
  if (projectionCount(request, 'turn-voice') !== 0 || projectionCount(request, 'final-voice-refresh') !== 0) {
    throw new Error('built off smoke projected persona')
  }
  if (eventsWithProjection(agent, 'turn-voice') !== 0 || eventsWithProjection(agent, 'final-voice-refresh') !== 0) {
    throw new Error('built off smoke logged persona events')
  }
}

// Reload: dispose removes the tool; remount registers exactly once.
{
  const home = await freshHome('reload')
  const adapter = new ScriptedAdapter([textResponse('built reload final')])
  const { ctx, fiber } = await makeContext(adapter, home)
  const assembly = await ctx.systemPrompt.assemble()
  if (assembly.sections.some(section => section.name.startsWith('mistymoon:'))) {
    throw new Error('built foundation registers a persona system-prompt section')
  }
  await fiber.dispose()
  if (ctx.tools.get(Foundation.FINAL_REPLY_TOOL) !== undefined) {
    throw new Error('built foundation tool leaked after dispose')
  }
  const remount = await ctx.plugin(Foundation, { home, defaultRoleplayMode: 'companion' })
  if (ctx.tools.get(Foundation.FINAL_REPLY_TOOL)?.name !== Foundation.FINAL_REPLY_TOOL) {
    throw new Error('built foundation tool did not remount once')
  }
  await remount.dispose()
  if (ctx.tools.get(Foundation.FINAL_REPLY_TOOL) !== undefined) {
    throw new Error('built foundation tool leaked after remount dispose')
  }
}

// Memory v2: built output creates transactional storage, fails closed on v1/corruption, and disposes cleanly.
{
  const root = await mkdtemp(join(tmpdir(), 'mistymoon-built-memory-'))
  const path = join(root, 'memories.jsonl')
  const access = {
    version: 1,
    ownerId: 'built-owner',
    authority: 'local-dsh-host-rpc',
    scope: { version: 1, kind: 'companion-reality' },
    channelDisclosure: 'personal-only',
    requestIntent: 'ordinary',
  }
  const ids = ['built-observation-1', 'built-memory-1']
  const archive = await Memory.openMemoryArchive({ path, createId: () => ids.shift() ?? 'unexpected-id' })
  await archive.observeExplicit({
    context: access,
    memoryKind: 'summary',
    sourceMessageId: 'built-source-1',
    text: '请记住：中性 built memory。',
  })
  if (archive.inspection().state !== 'ready' || archive.inspection().transactionCount !== 1) {
    throw new Error('built Memory archive did not create one ready v2 transaction')
  }
  await archive.dispose()
  await appendFile(path, '{"kind":"transaction"', 'utf8')
  const quarantined = await Memory.openMemoryArchive({ path })
  if (quarantined.inspection().issues[0]?.code !== 'trailing-partial-transaction'
    || quarantined.recall({ context: access, query: 'built memory' }).length !== 0) {
    throw new Error('built Memory archive did not fail closed on a partial transaction')
  }
  await quarantined.dispose()

  const legacyPath = join(root, 'legacy.jsonl')
  await writeFile(legacyPath, `${JSON.stringify({
    schemaVersion: 1,
    id: 'built-legacy-1',
    createdAt: '2026-08-18T00:00:00.000Z',
    content: 'Neutral built legacy fixture.',
    visibility: 'personal',
    sourceMessageId: 'built-legacy-source-1',
    status: 'confirmed',
  })}\n`, 'utf8')
  const legacy = await Memory.openMemoryArchive({ path: legacyPath })
  if (legacy.inspection().state !== 'scope-migration-required'
    || legacy.list({ context: access }).length !== 0) {
    throw new Error('built Memory archive did not fail closed on v1 input')
  }
  await legacy.dispose()
}

process.stdout.write('Built Cordis plugin smoke passed.\n')
