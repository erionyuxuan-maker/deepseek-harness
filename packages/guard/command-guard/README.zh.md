---
description: "命令守卫：一个 tools/pre-execute 策略，按配置的正则拒绝或升级 shell 命令，供选择、配置或调试该插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-guard

[English](README.md) | 中文

## 概述

本包负责拒绝无人值守下的危险 shell 命令。它监听 `tools/pre-execute` waterfall，用配置的正则匹配工具调用中承载命令的参数字段，然后返回策略拒绝（`deny`）或审批请求（`ask`）。`dsh` base bundle 以禁用状态携带该行；在 profile 补丁中启用即可守卫该 profile。匹配仅是建议性的：它读的是命令文本，不做进程隔离。规则只检查 `command`、`cmd`、`script` 字段，所以调用里的描述性 `description` 不会误触发规则。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

插件接受 `rules` 列表与可选的 `fields` 列表：

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

每条规则有一个稳定的 `id`、一个在加载时编译一次的 `pattern`、一个可选的 `tool` 通配（默认 `*`）、可选的 `flags`（默认 `i`）、一个 `action`（默认 `deny`，或 `ask`），以及可选的、面向模型的 `reason`。省略 `rules` 会装载本包的默认规则：针对文件系统根、home、通配符或点目录的强制递归删除、强制推送、`git clean -f`、递归 `del`/`rd` 开关、驱动器格式化、原始磁盘写入会被拒绝；`git reset --hard`、把下载的脚本管道进 shell、更改机器电源状态会被升级为审批。模式非法、id 为空或 id 重复的规则会让插件加载直接失败，而不是被跳过。

## Understand the implementation

`apply` 先编译规则，再注册一个 `tools/pre-execute` 监听器。监听器收集配置字段中的每个字符串值（含嵌套值），返回第一条匹配规则的决策，否则调用 `next()` 让后续策略继续运行。拒绝会带 `COMMAND_GUARD_DENIED` 结构化错误码；升级返回 `ask`，并以规则的原因作为审批提示文本。该注册是一个 `ctx.effect`，所以卸载插件会撤回守卫。

schema 默认值在这里是承重的：schemastery 会把缺失的数组归一化为 `[]`，因此 `rules` schema 自己携带默认规则集，而不是让空数组表示"没有规则"。

## 开发备注

本包是 `guard/` 策略形状的示例：一个扩展点、不改循环、配置失败即大声报错。它刻意把匹配放在一个纯函数（`matchRule`）里，使测试无需启动模型即可覆盖策略；同时有一个 spec 驱动真实工具管线，证明拒绝确实落成结果。

## Model Experience

### Conditional tool result

#### What the model sees

本插件不添加提示词段落或工具 schema。规则命中时，被拒绝调用的结果是 `Error: <reason>` 并携带 `COMMAND_GUARD_DENIED` 错误码，取代工具自身的输出；没有命中任何规则的调用原样通过。

#### Token effect

放行的调用零 token。拒绝会增加一条很小的保留错误结果，并阻止工具自身的输出进入上下文。

#### KV Cache effect

仅追加；插件不向请求添加内容，因此不会使可复用的前缀失效。

## Known Limitations and Deferred Work

- **是文本匹配，不是隔离** —— 模式可能漏掉等价写法（`rm -r -f /`、混淆过的 shell、别的工具）。隔离仍由 sandbox 后端负责，审批仍由审批服务负责；本插件只提供一个更早、可解释的拒绝。
- **只认命令字段** —— 若某个工具用别的参数名承载命令，在 `fields` 指明前不会被检查。
- **部署策略需显式开启** —— base 行以 `disabled: true` 携带；需要的 profile 自行启用，必须始终生效的规则应放进该 profile 的补丁而不是包的默认值。
