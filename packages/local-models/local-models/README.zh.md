# @deepseek-ai/dsh-local-models

[English](README.md) | 中文

`ctx.localModels` 能力 seam 及其唯一的 SSH 实现：对运行在远程主机上的本地模型服务进行生命周期控制。它让模型下拉框能列出所有本地模型、显示当前正在运行的模型，并启动／停止它们。

这是一个**服务**包：它默认导出 `LocalModelManager` 服务类，注册为 `ctx.localModels`。它是**可选启用**的——仅在“由一台工作站驱动某可达主机上的模型服务”的部署中挂载；它不属于随产品提供的 `dsh-base` bundle。当 seam 缺失时，`localModels.*` Host RPC 域返回空目录（null）而不报错；web 应用的**本地模型**下拉分区仅在 seam 返回条目时才渲染。

## 工作原理

harness 运行在工作站上，模型服务运行在通过**免密 SSH** 可达的远程主机上。该 seam 建模了这样一个事实：类 `llama-server` 的端点在单个端口上**一次只服务一个模型**，且忽略请求中的 model id——因此模型的身份是一个*生命周期句柄*（该启动哪个 run 脚本），而非 llm 路由的区分。所有本地模型都路由到同一个已配置的 llm selection（`route`）。

- **发现**——一次 `ssh <sshTarget> '…'` 列出 `scriptsDir` 中的 `run-*.sh`（排除 `.bak`），并解析各自的 `--alias`、脚本第二行的头部注释，以及两个可选的头部标签（`# drafter:` 与 `# nudge:`）。
- **启动**——先停止当前服务（端口只容得下一个），再以脱离终端的方式启动所选脚本（`setsid nohup ./run-<id>.sh > ./<id>.serverlog 2>&1 </dev/null &`），使其在 SSH 会话关闭后仍存活。在探测确认其就绪之前，该模型显示为 `starting`，上限由 `startTimeoutMs` 决定（由时间戳计算，而非后台定时器）。
- **停止**——在主机上运行 `stopCommand`（默认 `pkill -f llama-server`）。
- **运行状态**——对 `${probeBaseURL}/health`（返回 200 即为在线）与 `/v1/models`（正在服务的 alias）发起普通 `fetch`。正在服务的 alias 会被匹配回某个脚本；由本 seam 发起的启动会被归因到它所启动的那个模型。

一次启动或停止会发出 `localModels/state-changed`——一个无载荷的提示（与 `llm/adapters-updated` 相同），使每个客户端重新拉取目录。

### 从脚本为模型命名

每个下拉行都从 run 脚本本身取名，使列表保持简短，并携带能区分相似构建的细节：

- **基础名称**——脚本**第二行**头部注释的起始片段，取到第一个带空格的破折号（`—`/`–`/`-`）或句子分隔处为止；没有头部注释的脚本则回退到其 `--alias`，再回退到其 slug。
- **`# drafter:` 标签**——推测草稿模型（drafter）的标签（任意文本，如 `DFlash`、`DFlash 2`、`DSpark`、`none`），附加在基础名称之后。它可以出现在**任意**头部行。
- **`# nudge:` 标签**——nudge 补丁是否启用。`on`/`yes`/`true`/`1`/`active`/`enabled` 渲染为 `· nudge`；`off`/`no`/`false`/`0`/`inactive`/`stock`/`disabled` 渲染为 `· no nudge`；其他值（或缺少该标签）则不添加任何内容。

各片段以 ` · ` 连接。像这样打了标签的脚本：

```sh
#!/usr/bin/env bash
# Qwen3.8-27B (unsloth Q8_0) — MTP self-speculation, 128k context
# drafter: DFlash 2
# nudge: on
exec llama-server --alias qwen3.8 --port 8080 ...
```

会列为 **`Qwen3.8-27B (unsloth Q8_0) · DFlash 2 · nudge`**。drafter 与 nudge 无法可靠地从构建路径或 `--spec-type` 标志推断，因此只从这些显式标签读取；未打标签的脚本仅显示其基础名称。

## 配置

所有字段都是经校验的设置项；随部署而变的开关带有默认值。

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `sshTarget` | （必填） | 模型主机的 SSH 目标（例如 `ssh_config` 中的主机别名）。 |
| `scriptsDir` | （必填） | 主机上 `run-*.sh` 启动脚本所在目录；开头的 `~` 会在主机端展开。 |
| `probeBaseURL` | （必填） | 模型端点的基址，用于探测 `/health` 与 `/v1/models`。 |
| `providerId` | （必填） | 该分区所取代的 llm 提供方 id（其下拉分组）。 |
| `route` | （必填） | `{ provider, model }`——本地服务启动后要激活的 llm selection。 |
| `execCommand` | `ssh` | 用于连接主机的本地可执行文件。 |
| `stopCommand` | `pkill -f llama-server` | 停止正在运行的服务的远程命令。 |
| `startTimeoutMs` | `180000` | 已启动但尚未就绪的模型显示为 `starting` 的时长。 |
| `probeTimeoutMs` | `5000` | 每次端点探测的单请求超时。 |
| `graceMs` | `5000` | 本地 `ssh` 子进程的 SIGTERM→SIGKILL 宽限期。 |

```yaml
- name: '@deepseek-ai/dsh-local-models'
  config:
    sshTarget: dashi
    scriptsDir: ~/scripts/run
    probeBaseURL: http://192.168.0.131:8080
    providerId: local
    route: { provider: local, model: qwen3.8 }
```

## 模型体验

无：作为面向运维方的生命周期 seam，它不注册任何面向模型的工具，也不进入任何模型请求。

#### KV Cache 影响

无直接影响。切换正在运行的模型会改变共享本地端点所服务的内容；请求前缀由 llm 路由负责，而非本 seam。启动、停止与运行状态都不是模型可见的输入，因此不携带任何会话日志事件——它们改由转发的 `localModels/state-changed` host 事件承载。

## 已知限制与暂缓事项

- **单一传输方式（SSH）。** 仅支持可通过 `ssh` 到达的主机。受监管（systemd）传输或远程 HTTP 模型管理器将是本 seam 的另外的提供方；在出现第二种传输方式之前，Service Definition 与其唯一实现同处一个包内。
- **需要免密 SSH。** seam 通过 `ctx.subprocess` 外壳调用；不支持交互式认证。
- **每个端点一个模型。** `start` 总是先停止当前服务；不建模在不同端口上并发运行多个模型。
- **计算得到的 alias 不透明。** 若脚本的 `--alias` 是 shell 变量（`$MODEL_ALIAS`），则无法静态解析其 alias；此时其运行状态只能归因于本 seam 发起的启动，而非外部启动的服务。
- **`stopCommand` 依主机而定。** 默认的 `pkill -f llama-server` 是可配置的远程命令；若某部署的服务进程名不同（或运行于某监管进程之下），必须自行设置。
