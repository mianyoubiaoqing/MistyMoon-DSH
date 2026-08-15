import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Foundation from '../packages/foundation/lib/index.js'

const home = await mkdtemp(join(tmpdir(), 'mistymoon-built-'))
const ctx = new Context()
await ctx.plugin(SystemPrompt, { persona: 'neutral build smoke' })
const fiber = await ctx.plugin(Foundation, { home })
const persona = JSON.parse(await readFile(join(home, 'persona', 'persona.json'), 'utf8'))
if (persona.kind !== 'mistymoon.persona') throw new Error('built foundation did not initialize a persona')
await fiber.dispose()
process.stdout.write('Built Cordis plugin smoke passed.\n')
