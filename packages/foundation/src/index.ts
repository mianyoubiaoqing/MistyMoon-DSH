/**
 * Private-data bootstrap and publication safety for MistyMoon on DSH.
 * @module @mistymoon/dsh-foundation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PERSONA_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { fileURLToPath } from 'node:url'
import { loadPersona, renderPersona } from './persona-document.js'
import { initializePersona } from './persona-home.js'

export * from './persona-document.js'
export * from './persona-home.js'
export * from './publication.js'

/** Cordis plugin name. */
export const name = 'mistymoon-foundation'

/** DSH service used to replace the standard per-agent persona slot. */
export const inject = ['systemPrompt']

/** Foundation plugin configuration. */
export interface Config {
  /** User-owned MistyMoon data directory. */
  home: string
}

/** Runtime schema for the foundation plugin. */
export const Config: z<Config> = z.object({
  home: z.string().required(),
})

const PERSONA_TEMPLATE = fileURLToPath(new URL('../personas/template/persona.json', import.meta.url))

/**
 * Initialize private first-start state and project the validated persona through DSH.
 * @param ctx - Mounting Cordis context with the system-prompt registry.
 * @param config - Private data directory configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const initialized = await initializePersona({ privateHome: config.home, templatePath: PERSONA_TEMPLATE })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const transformed = await next()
    const text = renderPersona(await loadPersona(initialized.path))
    let replaced = false
    const sections = transformed.sections.map((section) => {
      if (section.name !== PERSONA_SECTION) return section
      replaced = true
      return { ...section, text }
    })
    if (!replaced) throw new Error(`DSH prompt assembly is missing persona slot ${JSON.stringify(PERSONA_SECTION)}`)
    return { ...transformed, sections }
  })
}
