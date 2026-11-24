import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as commandGuard from '../src/index.ts'
import { COMMAND_GUARD_DENIED, DEFAULT_FIELDS, DEFAULT_RULES, commandStrings, compileRules, matchRule } from '../src/policy.ts'
import type { Rule } from '../src/policy.ts'

function rules(configured: Rule[]): ReturnType<typeof compileRules> {
  return compileRules(configured)
}

describe('command-guard rule compilation', () => {
  it('rejects an empty id, a duplicate id, and an invalid pattern at plugin load', () => {
    expect(() => rules([{ id: '', pattern: 'x' }])).toThrow(/non-empty `id`/)
    expect(() => rules([{ id: 'dup', pattern: 'a' }, { id: 'dup', pattern: 'b' }])).toThrow(/duplicate rule id/)
    expect(() => rules([{ id: 'bad', pattern: '(' }])).toThrow(/invalid regular expression/)
  })

  it('treats every non-wildcard character of a tool pattern literally', () => {
    const [rule] = rules([{ id: 'literal', tool: 'a+b', pattern: 'x' }])
    expect(rule!.tool.test('a+b')).toBe(true)
    expect(rule!.tool.test('aab')).toBe(false)
  })

  it('defaults a rule to denial with a reason naming its id', () => {
    const [rule] = rules([{ id: 'named', pattern: 'x' }])
    expect(rule!.action).toBe('deny')
    expect(rule!.reason).toContain('named')
  })
})

describe('command-guard argument inspection', () => {
  it('reads only command-bearing fields, so a prose description never triggers a rule', () => {
    const call = { command: 'git push origin main', description: 'git push --force origin main' }
    expect(commandStrings(call, DEFAULT_FIELDS)).toEqual(['git push origin main'])
    expect(matchRule(rules([{ id: 'force', pattern: String.raw`--force\b` }]), 'bash', call)).toBeUndefined()
  })

  it('reads nested command fields', () => {
    expect(commandStrings({ script: { command: 'ls -la' } })).toEqual(['ls -la'])
  })
})

describe('command-guard default rules', () => {
  const defaults = rules([...DEFAULT_RULES])

  it('denies forced recursive removal of the root, home, wildcard, and dot targets', () => {
    for (const command of ['rm -rf /', 'rm -fr ~', 'rm -rf *', 'rm -rf ..', 'rm -rf .']) {
      expect(matchRule(defaults, 'bash', { command })?.id, command).toBe('rm-recursive-force')
    }
  })

  it('allows forced removal of an ordinary relative path', () => {
    expect(matchRule(defaults, 'bash', { command: 'rm -rf ./build' })).toBeUndefined()
    expect(matchRule(defaults, 'bash', { command: 'rm -rf node_modules' })).toBeUndefined()
    expect(matchRule(defaults, 'bash', { command: 'rm -rf /tmp/run-42' })).toBeUndefined()
  })

  it('denies a force push but allows an ordinary push', () => {
    expect(matchRule(defaults, 'bash', { command: 'git push --force origin main' })?.id).toBe('git-push-force')
    expect(matchRule(defaults, 'bash', { command: 'git push --force-with-lease origin main' })?.id).toBe('git-push-force')
    expect(matchRule(defaults, 'bash', { command: 'git push origin main' })).toBeUndefined()
  })

  it('escalates a hard reset and reports the ask action', () => {
    const matched = matchRule(defaults, 'bash', { command: 'git reset --hard HEAD~1' })
    expect(matched?.id).toBe('git-reset-hard')
    expect(matched?.action).toBe('ask')
  })

  it('denies recursive cmd deletes and raw disk writes', () => {
    expect(matchRule(defaults, 'bash', { command: 'del /s /q C:\\temp' })?.id).toBe('cmd-del-recursive')
    expect(matchRule(defaults, 'bash', { command: 'mkfs.ext4 /dev/sda1' })?.id).toBe('disk-write')
  })

  it('applies tool patterns and reports the plugin error code', () => {
    const scoped = rules([{ id: 'mcp-only', tool: 'mcp_*', pattern: 'delete', action: 'deny' }])
    expect(matchRule(scoped, 'bash', { command: 'delete' })).toBeUndefined()
    expect(matchRule(scoped, 'mcp_github', { command: 'delete' })?.id).toBe('mcp-only')
    expect(COMMAND_GUARD_DENIED).toBe('COMMAND_GUARD_DENIED')
  })

  it('leaves calls with no command field alone', () => {
    expect(matchRule(defaults, 'read', { path: '/etc/passwd' })).toBeUndefined()
  })
})

describe('command-guard through the real tool pipeline', () => {
  async function setup() {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(commandGuard)
    ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'run a shell command',
      parameters: { command: { type: 'string', required: true } },
      async execute(args) {
        return [{ type: 'text' as const, text: `ran ${args.command}` }]
      },
    }))
    return ctx
  }

  function call(command: string) {
    return {
      callId: brandString<ToolCallId>('guard-call'),
      name: 'bash',
      arguments: { command },
      signal: new AbortController().signal,
    }
  }

  it('denies a forced recursive root removal without invoking the tool body', async () => {
    const ctx = await setup()
    const result = await executeToolFixture(ctx, call('rm -rf /'))
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe(COMMAND_GUARD_DENIED)
    expect(JSON.stringify(result.content)).toContain('recursive forced removal')
  })

  it('runs an ordinary command unchanged', async () => {
    const ctx = await setup()
    const result = await executeToolFixture(ctx, call('git status --short'))
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('ran git status --short')
  })
})
