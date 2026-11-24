/**
 * Pure command-guard policy: rule compilation, command-argument extraction, and
 * matching. The plugin entry (`index.ts`) wires these into the
 * `tools/pre-execute` waterfall; tests drive them without a Cordis context.
 *
 * @module @deepseek-ai/dsh-command-guard/policy
 */

/** Structured error code carried by every denial the plugin returns. */
export const COMMAND_GUARD_DENIED = 'COMMAND_GUARD_DENIED'

/** One configured command rule. */
export interface Rule {
  /** Stable identifier quoted in diagnostics and in the default reason. */
  id: string
  /** Tool-name wildcard pattern; `*` (the default) matches every tool. */
  tool?: string
  /** Regular expression source matched against each command-bearing argument. */
  pattern: string
  /** RegExp flags; default `i`. */
  flags?: string
  /** `deny` returns a policy denial; `ask` routes the call through the approval service. */
  action?: 'deny' | 'ask'
  /** Model-facing denial reason; default names the rule id. */
  reason?: string
}

/**
 * The rule set a profile gets when it configures none: unattended destructive
 * commands are denied, and commands whose intent depends on the moment are
 * escalated to approval instead.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  {
    id: 'rm-recursive-force',
    pattern: String.raw`\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+(?:/|~|\*|\.{1,2})(?=$|\s|[;&|])`,
    action: 'deny',
    reason: 'command-guard: recursive forced removal of the filesystem root or home is not allowed',
  },
  {
    id: 'git-push-force',
    pattern: String.raw`\bgit\s+push\b[^;&|]*(?:--force(?:-with-lease)?\b|\s-f(?=\s|$))`,
    action: 'deny',
    reason: 'command-guard: force-pushing a branch rewrites published history; ask the user first',
  },
  {
    id: 'git-reset-hard',
    pattern: String.raw`\bgit\s+reset\s+--hard\b`,
    action: 'ask',
    reason: 'command-guard: `git reset --hard` discards uncommitted work',
  },
  {
    id: 'git-clean-force',
    pattern: String.raw`\bgit\s+clean\s+-[a-zA-Z]*f`,
    action: 'deny',
    reason: 'command-guard: `git clean -f` deletes untracked files irreversibly',
  },
  {
    id: 'cmd-del-recursive',
    pattern: String.raw`\b(?:del|erase|rd|rmdir)\b[^;&|]*\s/[sq]\b`,
    action: 'deny',
    reason: 'command-guard: recursive delete switch is not allowed unattended',
  },
  {
    id: 'format-drive',
    pattern: String.raw`\bformat\s+[a-zA-Z]:`,
    action: 'deny',
    reason: 'command-guard: formatting a drive destroys its contents',
  },
  {
    id: 'disk-write',
    pattern: String.raw`\b(?:diskpart|mkfs(?:\.\w+)?|dd\s+if=)`,
    action: 'deny',
    reason: 'command-guard: raw disk writes are not allowed',
  },
  {
    id: 'remote-script-to-shell',
    pattern: String.raw`\b(?:curl|wget)\b[^;&|]*\|\s*(?:ba|z|k)?sh\b`,
    action: 'ask',
    reason: 'command-guard: piping a downloaded script into a shell executes unread code',
  },
  {
    id: 'power-state',
    pattern: String.raw`\b(?:shutdown|Stop-Computer|Restart-Computer)\b`,
    action: 'ask',
    reason: 'command-guard: changing machine power state needs the user\'s decision',
  },
]

/** The default argument field names inspected for command text. */
export const DEFAULT_FIELDS: readonly string[] = ['command', 'cmd', 'script']

/** One rule compiled once at plugin load. */
export interface CompiledRule {
  readonly id: string
  readonly tool: RegExp
  readonly pattern: RegExp
  readonly action: 'deny' | 'ask'
  readonly reason: string
}

/**
 * Compile one `*`-wildcard tool pattern to an anchored RegExp; every other
 * regular-expression metacharacter matches literally.
 * @param pattern - wildcard pattern such as `bash` or `mcp_*`.
 * @returns the anchored matcher.
 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Validate and compile a rule list, failing loud at plugin load rather than
 * silently skipping a broken rule.
 * @param rules - configured rules, or the default set.
 * @returns the compiled rules in configuration order.
 * @throws If an id or pattern is empty, an id repeats, or a pattern is not a valid regular expression.
 */
export function compileRules(rules: readonly Rule[]): CompiledRule[] {
  const seen = new Set<string>()
  return rules.map((rule) => {
    if (rule.id === '') throw new Error('command-guard: every rule needs a non-empty `id`')
    if (seen.has(rule.id)) throw new Error(`command-guard: duplicate rule id ${JSON.stringify(rule.id)}`)
    seen.add(rule.id)
    if (rule.pattern === '') throw new Error(`command-guard: rule ${JSON.stringify(rule.id)} needs a non-empty \`pattern\``)
    let pattern: RegExp
    try {
      pattern = new RegExp(rule.pattern, rule.flags ?? 'i')
    } catch (error) {
      throw new Error(`command-guard: rule ${JSON.stringify(rule.id)} has an invalid regular expression`, { cause: error })
    }
    return {
      id: rule.id,
      tool: wildcardToRegExp(rule.tool ?? '*'),
      pattern,
      action: rule.action ?? 'deny',
      reason: rule.reason ?? `command-guard: rule ${rule.id} matched`,
    }
  })
}

/**
 * Collect the command-bearing strings of one tool call.
 * @param value - the call arguments.
 * @param fields - argument field names that carry a command.
 * @returns every matching string value, including nested ones.
 */
export function commandStrings(value: unknown, fields: readonly string[] = DEFAULT_FIELDS): string[] {
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (typeof item === 'string') {
        if (fields.includes(key)) found.push(item)
        continue
      }
      visit(item)
    }
  }
  visit(value)
  return found
}

/**
 * Find the first rule that refuses this call.
 * @param rules - compiled rules in configuration order.
 * @param toolName - the tool the model asked to run.
 * @param argumentsValue - the call arguments.
 * @returns the matching rule, or `undefined` when the call may proceed.
 */
export function matchRule(
  rules: readonly CompiledRule[],
  toolName: string,
  argumentsValue: unknown,
): CompiledRule | undefined {
  for (const rule of rules) {
    if (!rule.tool.test(toolName)) continue
    const strings = commandStrings(argumentsValue)
    if (strings.length === 0) continue
    if (strings.some(text => rule.pattern.test(text))) return rule
  }
  return undefined
}
