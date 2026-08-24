# 本地模型生命周期

[English](local-models.md) | 中文

[dsh-local-models](../../packages/local-models/local-models) 是可选启用的 `ctx.localModels` 服务，用于从模型下拉框驱动运行在远程工作站上的模型服务器。它通过 `ctx.subprocess`（一个 `ssh` 子进程）发现主机上的 `run-*.sh` 启动脚本，探测模型端点以获取运行状态，并一次启动或停止一个服务器。`llama-server` 在探测端口上一次只服务一个模型，且忽略请求中的模型 id，因此模型 id 是一个生命周期句柄——启动哪个脚本——而不是 llm 路由上的区分；每个条目都路由到目录唯一的 {@link LocalModelRoute}。因此选择一个模型意味着「让它成为正在运行的那个」，而 Stop 控件会释放加速器。它不属于 agent loop（智能体循环）主干，也不在随附默认组合中：需要驱动远程模型服务器的工作站会用主机配置将其挂载，而 [`localModels.*` Host RPC 域](web-server.zh.md)通过 `ctx.get('localModels')` 消费它，服务缺失时返回空目录。其设计——SSH 传输、选择即启动、实时发现——由[本地模型生命周期 Agent Note](../../.agents/notes/implemented/feature/2026-08-22-local-model-lifecycle.zh.md)规定；组合方式、Config 表以及确切的发现与启停机制见[包 README](../../packages/local-models/local-models/README.zh.md)。

源码：[`packages/local-models/local-models/src/types.ts`](../../packages/local-models/local-models/src/types.ts)

## 运行状态与路由

启动以分离方式发起，其就绪由稍后的探测观察到，因此一个条目在读作 `running` 之前会先经过一个 `starting` 窗口。该窗口由从启动时间戳计算的启动预算界定，而非后台定时器；超过预算后，仍未就绪的启动会回落到 `stopped`。

```ts type-equiv
/**
 * Lifecycle state of one local model server as the seam reports it:
 * `running` (its `/health` is up and it is the server on the probe port),
 * `starting` (a start was launched and readiness has not yet been observed,
 * within the start budget), or `stopped` (neither).
 */
type LocalModelRunState = 'running' | 'starting' | 'stopped'
```

每个被发现的脚本都路由到同一个 llm 选择：端点只接受一个模型 id，因此目录携带单一路由，由已启动的服务器激活，而不是每个脚本一个路由。

```ts type-equiv
/** The llm selection a started local server routes turns to. */
interface LocalModelRoute {
  /** Registered llm provider route (the single local endpoint route). */
  provider: string
  /** Provider-owned model id accepted by that route. */
  model: string
}
```

## 目录条目

条目以其 run 脚本的 slug 为键。脚本服务的 `--alias` 会在可能时静态解析；计算得到的别名（一个 shell 变量）会使 `alias` 缺失，这类条目依赖最近一次启动的 id 来归因其运行状态。

```ts type-equiv
/**
 * One local model server, keyed by its run-script slug. `llama-server` serves
 * one model and ignores the requested model id, so `id` is a lifecycle handle
 * (which script to launch), not an llm-routing distinction — every entry routes
 * to the catalog's single {@link LocalModelRoute}.
 */
interface LocalModelEntry {
  /** Script slug: the `run-*.sh` filename with `run-` and `.sh` stripped. */
  id: string
  /** Compact display name: the header comment's leading segment plus any `# drafter:`/`# nudge:` tags, else the alias or id. */
  name: string
  /** The `--alias` the script serves, when statically parseable; absent for computed aliases. */
  alias?: string
  /** Full header-comment text, when present, for a hover tooltip. */
  description?: string
  /** Current lifecycle state as the last probe resolved it. */
  runState: LocalModelRunState
  /** Absolute path of the run script on the remote host. */
  scriptPath: string
}
```

`list` 将发现的脚本与当前运行状态一起折叠为一个目录。当端点关闭，或它服务的模型无法归因到某个已知脚本时，`running` 为 null。

```ts type-equiv
/**
 * The discovered local catalog plus which entry currently serves the probe
 * endpoint. `running` is the entry id, or null when the endpoint is down or
 * serving a model this seam cannot attribute to a known script.
 */
interface LocalModelCatalog {
  /** The llm provider id whose dropdown group this catalog supersedes. */
  providerId: string
  /** The llm selection to activate once a server is up. */
  route: LocalModelRoute
  /** Entry id currently serving the probe endpoint, or null. */
  running: string | null
  /** Every discovered run script (`.bak` excluded), with per-entry run-state. */
  models: readonly LocalModelEntry[]
}
```

## 端点探测

运行状态来自对模型端点的 HTTP 探测，而非启动命令本身：`/health` 报告就绪（llama.cpp 加载中返回 503，就绪时返回 200），`/v1/models` 报告所服务的 `--alias`。别名会匹配回某个被发现的脚本，因此外部启动的服务器只要其别名可解析也能被归因。

```ts type-equiv
/**
 * Result of probing the model endpoint: whether `/health` is up and the model
 * id `/v1/models` reports serving (the running `--alias`), or null when the
 * endpoint is down or its model list is unreadable.
 */
interface LocalModelStatus {
  /** The `id` from `/v1/models` (the running `--alias`), or null. */
  runningAlias: string | null
  /** True when `/health` returned 200. */
  healthy: boolean
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlocalmodels--localmodelmanager"></a>

### `ctx.localModels` — `LocalModelManager`

SSH-backed local-model lifecycle manager. Discovery and start/stop each run one remote command; run-state comes from probing the model endpoint. One model runs at a time, so `start` stops the current server first.

```ts cordis-catalog
/**
 * Discover the remote run scripts and fold in current run-state.
 * @param signal - aborts discovery and the endpoint probe.
 * @returns the local catalog with the running entry and per-entry state.
 */
async list(signal?: AbortSignal): Promise<LocalModelCatalog>

/**
 * Probe the model endpoint directly.
 * @param signal - aborts the probe.
 * @returns the endpoint's health and served model id.
 */
async status(signal?: AbortSignal): Promise<LocalModelStatus>

/**
 * Make one model the server running on the endpoint: stop the current server
 * (only one fits), launch the requested script detached, and mark it
 * `starting`. Readiness is observed by a later {@link list}/{@link status}.
 * @param id - script slug to start.
 * @param signal - aborts the stop/launch commands (not the launched server).
 * @throws Error for an unknown/unsafe id, an SSH failure, or a non-zero remote exit.
 */
async start(id: string, signal?: AbortSignal): Promise<void>

/**
 * Stop the running model server, freeing the endpoint and the accelerator.
 * @param signal - aborts the stop command.
 * @throws Error on an SSH failure or a stop-command exit other than success/no-match.
 */
async stop(signal?: AbortSignal): Promise<void>
```

Source: [`packages/local-models/local-models/src/index.ts`](../../packages/local-models/local-models/src/index.ts)

<a id="localmodels-events"></a>

### `localModels/*` events

<a id="localmodelsstate-changed--emit"></a>

#### `localModels/state-changed` — emit

A local model server's lifecycle changed — a start was launched or a stop ran. Consumers refetch the catalog; the payload-free nudge mirrors `llm/adapters-updated`.

```ts cordis-catalog
/**
 * A local model server's lifecycle changed — a start was launched or a stop
 * ran. Consumers refetch the catalog; the payload-free nudge mirrors
 * `llm/adapters-updated`.
 * @mode emit
 */
'localModels/state-changed'(): void
```

Source: [`packages/local-models/local-models/src/types.ts`](../../packages/local-models/local-models/src/types.ts)
<!-- END GENERATED cordis-surface -->
