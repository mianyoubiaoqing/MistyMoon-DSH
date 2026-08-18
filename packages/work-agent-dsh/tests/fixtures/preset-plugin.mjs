import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

export const inject = ['systemPrompt', 'tools']

export function apply(ctx, config) {
  if (config.failSetup === true) {
    throw new Error('neutral preset fixture setup failed')
  }
  ctx.systemPrompt.section({
    name: config.sectionName,
    order: 20,
    text: config.prompt,
  })
  ctx.tools.register(defineContentToolFixture({
    name: config.toolName,
    description: `Neutral fixture tool for ${config.toolName}.`,
    parameters: {},
    async execute() {
      return [{ type: 'text', text: `${config.toolName}:ok` }]
    },
  }))
}
