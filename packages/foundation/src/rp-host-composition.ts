/** RP Host preset-scoped complete Persona and legacy-delivery exclusion. */

import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { PERSONA_ORDER, PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { PublishedPersonaProjection } from './persona-projection.js'
import type { RoleplayController } from './roleplay.js'

/** Cordis plugin name used only inside the versioned RP Host preset. */
export const name = 'mistymoon-rp-host-composition'

/** RP Host needs the shared published snapshot and DSH prompt/tool registries. */
export const inject = ['mistymoonPersonaProjection', 'mistymoonRoleplay', 'systemPrompt', 'tools']

/** Complete executable tool surface for the Owner-facing RP Host preset. */
export const RP_HOST_TOOL_ALLOWLIST = Object.freeze([
  'web_search',
  'web_fetch',
  'read',
  'grep',
  'glob',
  'mistymoon_code_flash',
  'ask_user_question',
])

/** Use Persona as the RP Host identity; preserve every unclassified governance/tool section. */
function keepRpHostPromptSection(name: string): boolean {
  return name !== 'harness:identity'
}

function requestedLocalPath(exec: ToolExecution): string | undefined {
  if (typeof exec.arguments !== 'object' || exec.arguments === null || Array.isArray(exec.arguments)) {
    return undefined
  }
  const args = exec.arguments as Record<string, unknown>
  if (exec.name === 'read') return typeof args.file_path === 'string' ? args.file_path : undefined
  if (exec.name === 'grep' || exec.name === 'glob') {
    return args.path === undefined ? '.' : typeof args.path === 'string' ? args.path : undefined
  }
  return undefined
}

/** Deny filesystem inspection that cannot be proven to stay inside this Session's workspace. */
function workspaceBoundaryReason(exec: ToolExecution): string | undefined {
  if (exec.name !== 'read' && exec.name !== 'grep' && exec.name !== 'glob') return undefined
  const cwd = exec.agent?.session.header.cwd
  const requestedPath = requestedLocalPath(exec)
  if (cwd === undefined || requestedPath === undefined) {
    return `The RP Host may use ${exec.name} only inside the current session workspace.`
  }
  try {
    const workspace = realpathSync.native(cwd)
    const target = realpathSync.native(resolve(cwd, requestedPath))
    const fromWorkspace = relative(workspace, target)
    if (fromWorkspace === '' || (fromWorkspace !== '..'
      && !fromWorkspace.startsWith(`..${sep}`)
      && !isAbsolute(fromWorkspace))) {
      return undefined
    }
  } catch {
    // A missing or unresolvable target cannot be proven to remain confined.
  }
  return `The RP Host may use ${exec.name} only inside the current session workspace.`
}

function installRpHostToolGate(ctx: Context): () => void {
  let liftScopeProbe: () => void
  try {
    // DSH's public restriction seam proves this plugin is mounted in a real
    // scoped context. Lift the empty probe immediately: freezing a partial
    // global catalog here would hide allowed tools that finish registering
    // later in the preset's parallel loader.
    liftScopeProbe = ctx.tools.restrict({ allow: [] })
  } catch (cause) {
    throw new Error('mistymoon-rp-host: tool policy requires a DSH scope', { cause })
  }
  liftScopeProbe()
  const liftGuard = ctx.tools.guard((exec) => {
    if (!RP_HOST_TOOL_ALLOWLIST.includes(exec.name)) {
      return 'The RP Host may use only read-only Web, workspace inspection, Owner confirmation, and fixed Work delegation tools.'
    }
    return workspaceBoundaryReason(exec)
  })
  return liftGuard
}

/**
 * Mount the RP-preset-only complete Persona section.
 *
 * The surrounding preset contributes read-only Web/workspace inspection,
 * Owner confirmation, and fixed delegation tools. This module removes the
 * globally available legacy finalization tool; all other presets remain on
 * Foundation's two-phase delivery path.
 */
export async function apply(ctx: Context): Promise<void> {
  const projection = ctx.get('mistymoonPersonaProjection', true) as PublishedPersonaProjection
  const roleplay = ctx.get('mistymoonRoleplay', true) as RoleplayController
  await ctx.effect(
    () => installRpHostToolGate(ctx),
    'mistymoon-rp-host: enforce read-only Web, workspace inspection, and fixed delegation tools',
  )
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: (context) => {
      const agent = (context as { agent?: Parameters<RoleplayController['get']>[0] }).agent
      return agent !== undefined && roleplay.get(agent).mode === 'off'
        ? ''
        : projection.current().text
    },
  }), 'mistymoon-rp-host: published Persona system projection')
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return {
      ...assembly,
      sections: assembly.sections.filter(section => keepRpHostPromptSection(section.name)),
      tools: assembly.tools.filter(tool => RP_HOST_TOOL_ALLOWLIST.includes(tool.name)),
    }
  })
}
