# Agent Note：从模型下拉框控制远程本地模型服务

Status: implemented

[English](2026-08-22-local-model-lifecycle.md) | 中文

## Problem

某工作站部署需要访问运行在远程主机上、自托管的类 `llama-server` 模型服务；每个服务由一个 `run-*.sh` 脚本启动，在共享端口上服务一个模型。harness 此前只能通过某个 `llm-pi-ai` 提供方访问它们，而该提供方的设置里只列了一个模型，因此模型下拉框既无法枚举其他模型，也无法显示哪个正在运行，更无法启动／停止它们。切换模型意味着手动 SSH 登录主机。

决定性的事实是：`llama-server` 在其端口上一次只服务一个模型，且实际上忽略请求中的 model id，而本地 llm 路由只校验其唯一已配置的 model id。因此“哪个脚本在运行”是一个*生命周期*维度，而非 llm 路由维度——所有本地脚本都路由到同一个已配置的 llm selection。模型的身份是*该运行哪个服务进程*的句柄，而非一个可独立路由的模型。

## Decision

三层结构，外加可选启用的挂载。

**Seam + SSH 实现——`@deepseek-ai/dsh-local-models`。** 一个 `LocalModelManager` 服务将 `ctx.localModels` 注册为 `list`／`status`／`start`／`stop`。发现、启动、停止各是一次 `ssh <target> '<远程命令>'`，经由 `ctx.subprocess` 在 `RemoteRunner` seam 之后驱动（因此编排逻辑无需真实子进程或网络即可单测）；运行状态来自对 `${probeBaseURL}/health` 与 `/v1/models` 的普通 `fetch`。`start` 先停止当前服务（端口只容一个），以脱离终端的方式启动脚本（`setsid nohup … </dev/null &`），使其在 SSH 会话关闭后仍存活，并将该模型标记为 `starting`。这个 `starting` 窗口在每次 `list` 时由启动时间戳与 `startTimeoutMs` 惰性计算，因此没有需要拥有或释放的后台定时器。一次启动或停止会发出 `localModels/state-changed`——一个无载荷的转发事件（在 seam 的 `types` 子模块中声明），与 `llm/adapters-updated` 对应。Service Definition 与其唯一提供方同处一个包内：能力 seam 规则要求在出现第二种传输方式（systemd、远程 HTTP）之前保持它们在一起。所有主机／端点事实都是经校验的 `Config` 字段，通过设置分区实时读取，包括 `route`（服务启动后要激活的 llm selection）与 `stopCommand`。

**Host RPC——`dsh-host-apiproxy` 中的 `localModels.*`。** 一个薄域（`list`／`start`／`stop`）沿用可选服务 `goals`／`jobs` 的模式：它读取 `ctx.get('localModels')`，当 seam 未挂载时 `list` 返回**空目录（null）**（客户端据此不渲染任何内容的“可选启用—缺失”信号），而当传输失败或 seam 缺失时 `start`／`stop` 返回 `local-models-error` 分支。wire 词汇即 seam 自身的类型，从 `dsh-local-models/types` 以仅类型方式导入，并经契约层重新导出给客户端。

**下拉框——`ui-model-selection` 中的“本地模型”分区。** 每会话的 `ModelDirectory` 在 llm 目录之外新增一条本地目录轴（`loadLocal`／`startLocal`／`stopLocal`，各自独立的 generation 守卫）；composer 服务订阅 `localModels/state-changed`。`ModelSelect` 会过滤掉 id 等于本地 `providerId` 的那个原始 llm 分组（生命周期分区取而代之），并渲染发现到的模型：带运行状态徽标、在运行中的那个上带 Stop 控件，并采用“选择即启动”：选中一个已停止的模型会调用 `startLocal`（成功后将会话路由到目录的 `route`），选中正在运行的那个则仅关闭菜单。当某模型处于 `starting` 且菜单打开时，组件会轮询 `loadLocal`，使徽标推进到 running。当会话处于本地路由时，触发器以正在运行的本地模型标注自身。

**从脚本生成显示名称。** 发现到的模型在下拉框中的名称由脚本本身组合而成，而非其不透明的 slug：取脚本第二行头部注释的起始片段（在第一个带空格的破折号或句子分隔处截断），再拼接两个可选的头部标签——`# drafter:`（推测草稿模型标签，如 `DFlash 2`）与 `# nudge:`（nudge 补丁是否启用，on/off）——以 ` · ` 连接。未打标签的脚本回退为仅注释，再回退为其 alias，再回退为其 slug；完整的头部注释则作为 `LocalModelEntry.description` 随行，用于悬停提示。drafter 与 nudge *只*从这些显式标签读取，因为它们无法可靠推断：在真实主机的脚本中，drafter 的编码并不一致（`--spec-type draft-dflash` 依构建不同可能表示 DFlash 1 或 DFlash 2），而 nudge 补丁只体现为某个构建／toolbox 路径的子串，因此自动检测会误标。用户按脚本逐个选择加入：添加这两行标签，其余由 harness 组合。

**可选启用。** 该包不加入 `dsh-base`。没有 seam 时 apiproxy 域是惰性的，而下拉分区仅在 `list` 返回目录时才渲染，因此其他部署不受影响。某部署通过在自己的 profile 中以主机配置挂载 `@deepseek-ai/dsh-local-models` 来启用它。

## Alternatives considered

**将发现到的每个模型注册进 `ctx.llm` 的本地提供方之下。** 否决：llm 路由会针对其目录校验 `selectModel`，因此任意发现到的 id 都需要成为目录成员，而既然端点忽略 model id，所有条目本就路由到相同目标。将所有本地选择都路由到那一个已配置的 llm 条目、由生命周期分区负责每脚本身份与运行状态，能让 llm 目录保持诚实，且无需跨插件写设置。

**重载 `session.selectModel`，把启动服务作为副作用。** 否决：会话选择保持为纯粹的路由动作；生命周期归其自身的 seam。客户端将两者组合——先启动，再选择 route——而非由 Host 将它们耦合。

**在 Host 上以后台就绪轮询来跟踪 `starting`。** 否决，改用惰性计算的时间戳：已启动的模型显示为 `starting`，直到下一次 `list` 看到它就绪或预算耗尽，因此 seam 不拥有任何长生命周期定时器，而客户端在启动进行中通过轮询 `list` 驱动状态转换（再加上变更事件用于跨客户端收敛）。

**现在就把 seam 拆成 Definition 与 Provider 两个包。** 暂缓：当前只有一种传输方式（SSH）。设计时提出的 systemd 与远程 HTTP 传输才是未来的拆分点；在第二个提供方出现之前拆分，正是能力 seam 规则所警示的过早抽象。

## Consequences

开箱即用时一切不变：该功能可选启用，且不在随产品提供的默认项中。在挂载处，下拉框会列出每个 `run-*.sh`（排除 `.bak`）、为正在运行的那个打徽标，并从菜单启动／停止；原始的本地 llm 分组被隐藏，取而代之的是生命周期分区，且一次启动会把会话路由到已配置的本地 route。该 seam 需要免密 SSH，且每端点一个模型；`--alias` 为计算得到的脚本，其运行状态只能归因于本 seam 发起的启动。`local-models` 包具备完整的单元与设置覆盖；apiproxy 域有“存在／缺失／错误”测试；下拉框有渲染／交互测试。客户端 GUI 文件（`ModelSelect.tsx`、`directory.ts`、`service.ts`）处于 `vitest.config.ts` 现有的客户端覆盖豁免之下，`api-proxy.ts` 处于其自身的豁免之下，因此这些层以行为测试而非逐文件门禁来保障。一个真实组合的 web e2e（`apps/web/tests/local-models-dropdown.e2e.ts`）以一个假的 `ssh` 可执行文件和一个代替远程主机的本地 HTTP 端点替身启动组装后的 web 应用，随后驱动下拉框走完发现 → 启动 → 停止，断言运行状态徽标以及分区的 golden 渲染。构建它时暴露了两个现已修复的缺口：可选启用的包必须是 `apps/cli` 的依赖（`workspace:^`），profile 才能挂载它——已安装但不在任何默认组合中，与 `tool-cordis` 完全一致——并且 `ModelSelect` 必须在挂载时和打开时刷新本地目录（`loadLocal`，与 llm 的 `load` 对称），否则对于在连接重置之后创建的会话目录，该分区永远不会填充。针对真实主机的实机冒烟——它会启动并停止真实的模型服务——是余下的验证项。
