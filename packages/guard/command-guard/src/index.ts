/**
 * Command guard: a `tools/pre-execute` policy that denies or escalates shell
 * commands whose text matches a configured regular expression.
 *
 * Matching is advisory policy over the command text a model asked to run, not
 * confinement: a pattern can miss an equivalent spelling, so deployment
 * confinement stays on `ctx.sandbox` and approval stays on the approval service.
 * Rules inspect only command-bearing argument fields, so a call's prose
 * `description` never triggers a rule.
 *
 * @module @deepseek-ai/dsh-command-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  COMMAND_GUARD_DENIED,
  DEFAULT_FIELDS,
  DEFAULT_RULES,
  commandStrings,
  compileRules,
} from './policy.ts'
import type { Rule } from './policy.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'command-guard'

/** The tool registry whose pre-execute gate this policy extends. */
export const inject = ['tools']

/** Plugin configuration, validated by the same-named schemastery schema plus `apply`'s load-time checks. */
export interface Config {
  /** Rules evaluated in order; omitting the field installs {@link DEFAULT_RULES}, while an explicitly empty list matches nothing. */
  rules?: Rule[]
  /** Argument field names that carry a command; default `['command', 'cmd', 'script']`. */
  fields?: string[]
}

/**
 * Schemastery schema bounding the loader configuration. The default rule set
 * lives in the schema because schemastery normalizes an absent array to `[]`;
 * `apply`'s fallback alone would never see an absent field.
 */
export const Config: z<Config> = z.object({
  rules: z.array(z.object({
    id: z.string().required(),
    tool: z.string().default('*'),
    pattern: z.string().required(),
    flags: z.string().default('i'),
    action: z.union(['deny', 'ask'] as const).default('deny'),
    reason: z.string(),
  })).default(DEFAULT_RULES.map(rule => ({ ...rule }))),
  fields: z.array(z.string()).default([...DEFAULT_FIELDS]),
})

/**
 * Install the guard's `tools/pre-execute` listener.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - validated configuration; rules compile fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const compiled = compileRules(config.rules ?? DEFAULT_RULES)
  const fields = config.fields as string[]

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const strings = commandStrings(exec.arguments, fields)
    if (strings.length === 0) return next()
    const rule = compiled.find(candidate => candidate.tool.test(exec.name) && strings.some(text => candidate.pattern.test(text)))
    if (rule === undefined) return next()
    if (rule.action === 'ask') {
      return { kind: 'ask', reason: rule.reason, displayReason: { en: rule.reason } }
    }
    return {
      kind: 'deny',
      reason: rule.reason,
      info: { name: 'CommandGuardError', code: COMMAND_GUARD_DENIED },
    }
  })
}

export type { CompiledRule, Rule } from './policy.ts'
