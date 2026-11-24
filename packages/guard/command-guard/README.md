---
description: "Command guard: a tools/pre-execute policy that denies or escalates shell commands matching configured patterns, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-guard

English | [中文](README.zh.md)

## Summary

This package refuses unattended destructive shell commands. It listens on the `tools/pre-execute` waterfall, matches configured regular expressions against the command-bearing arguments of a call, and returns a policy denial (`deny`) or an approval request (`ask`). The `dsh` base bundle ships the row disabled; enable it in a profile patch to guard that profile. Matching is advisory: it reads command text, it does not confine the process. Rules inspect only `command`, `cmd`, and `script` fields, so a call's prose `description` never trips a rule.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The plugin takes a `rules` list and an optional `fields` list:

```yaml
- id: command-guard
  name: '@deepseek-ai/dsh-command-guard'
  config:
    fields: ['command', 'script']
    rules:
      - id: no-force-push
        tool: bash
        pattern: '\bgit\s+push\b[^;&|]*--force\b'
        action: deny
        reason: 'Force-pushing published history needs the user.'
      - id: no-reset
        pattern: '\bgit\s+reset\s+--hard\b'
        action: ask
```

Each rule has a stable `id`, a `pattern` compiled once at load, an optional `tool` wildcard (default `*`), an optional `flags` (default `i`), an `action` (`deny` by default, or `ask`), and an optional model-facing `reason`. Omitting `rules` installs the package defaults: forced recursive removal of the filesystem root, home, wildcard, or dot targets; force pushes; `git clean -f`; recursive `del`/`rd` switches; drive formatting; and raw disk writes are denied, while `git reset --hard`, piping a downloaded script into a shell, and machine power-state changes are escalated. A rule whose pattern is invalid, whose id is empty, or whose id repeats fails plugin load instead of being skipped.

## Understand the implementation

`apply` compiles the rules, then registers one `tools/pre-execute` listener. The listener collects every string value of a configured argument field (nested values included), returns the first matching rule's decision, and otherwise calls `next()` so later policy still runs. Denials carry `COMMAND_GUARD_DENIED` as the structured error code; escalation returns `ask` with the rule's reason as the approval prompt text. The registration is a `ctx.effect`, so unloading the plugin withdraws the guard.

The schema default is load-bearing: schemastery normalizes an absent array to `[]`, so the `rules` schema carries the default rule set itself rather than leaving the empty array to mean "no rules".

## Dev Note

The package exists as the worked example for the `guard/` policy shape: one extension point, no loop changes, and a fail-loud configuration. It deliberately keeps matching in one pure function (`matchRule`) so tests cover policy without booting a model, while one spec drives the real tool pipeline to prove the denial materializes.

## Model Experience

### Conditional tool result

#### What the model sees

This plugin adds no prompt section or tool schema. When a rule matches, the refused call's result is `Error: <reason>` carrying the `COMMAND_GUARD_DENIED` code instead of the tool's output; a call that matches no rule passes through unchanged.

#### Token effect

Zero tokens on allowed calls. A denial adds one small retained error result and prevents the tool's own output from entering context.

#### KV Cache effect

Append-only; the plugin adds no request content, so it never invalidates a reusable prefix.

## Known Limitations and Deferred Work

- **Text matching, not confinement** — a pattern can miss an equivalent spelling (`rm -r -f /`, an obfuscated shell, a different tool). Confinement stays with the sandbox backend and approvals stay with the approval service; this plugin adds an early, explainable refusal.
- **Command fields only** — a tool that carries its command under another argument name is uninspected until `fields` names it.
- **Deployment policy is opt-in** — the base row ships `disabled: true`; a profile that wants the guard enables it, and rules that must always apply belong in that profile's patch rather than the package defaults.
