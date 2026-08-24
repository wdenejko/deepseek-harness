# Local Model Lifecycle

English | [中文](local-models.zh.md)

[dsh-local-models](../../packages/local-models/local-models) is the opt-in `ctx.localModels` service that drives model servers running on a remote workstation from the model dropdown. It discovers the `run-*.sh` launch scripts on the host over `ctx.subprocess` (an `ssh` child), probes the model endpoint for run-state, and starts or stops one server at a time. `llama-server` serves one model at a time on the probe port and ignores the requested model id, so a model id is a lifecycle handle — which script to launch — not an llm-routing distinction; every entry routes to the catalog's single {@link LocalModelRoute}. Selecting a model therefore means "make it the one running", and a Stop control frees the accelerator. It is not part of the agent-loop spine and not in shipped defaults: a workstation that drives remote model servers mounts it with the host's config, and the [`localModels.*` Host RPC domain](web-server.md) consumes it through `ctx.get('localModels')`, returning a null catalog when the service is absent. The design — SSH transport, select-to-start, live discovery — is owned by the [local-model lifecycle Agent Note](../../.agents/notes/implemented/feature/2026-08-22-local-model-lifecycle.md); composition, the Config table, and the exact discovery and start/stop mechanics live in the [package README](../../packages/local-models/local-models/README.md).

Source: [`packages/local-models/local-models/src/types.ts`](../../packages/local-models/local-models/src/types.ts)

## Run state and route

A start is launched detached and its readiness is observed by a later probe, so an entry passes through a `starting` window before it reads as `running`. The window is bounded by a start budget computed from the launch timestamp rather than a background timer; past the budget a still-unready launch reverts to `stopped`.

```ts type-equiv
/**
 * Lifecycle state of one local model server as the seam reports it:
 * `running` (its `/health` is up and it is the server on the probe port),
 * `starting` (a start was launched and readiness has not yet been observed,
 * within the start budget), or `stopped` (neither).
 */
type LocalModelRunState = 'running' | 'starting' | 'stopped'
```

Every discovered script routes to one llm selection: the endpoint accepts one model id, so the catalog carries a single route that a started server activates rather than one route per script.

```ts type-equiv
/** The llm selection a started local server routes turns to. */
interface LocalModelRoute {
  /** Registered llm provider route (the single local endpoint route). */
  provider: string
  /** Provider-owned model id accepted by that route. */
  model: string
}
```

## Catalog entries

An entry is keyed by its run-script slug. The `--alias` the script serves is parsed statically when possible; a computed alias (a shell variable) leaves `alias` absent, and such an entry relies on the last-started id for its run-state attribution.

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

`list` folds the discovered scripts together with the current run-state into one catalog. `running` is null when the endpoint is down, or when it serves a model this seam cannot attribute to a known script.

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

## Endpoint probe

Run-state comes from an HTTP probe of the model endpoint, not from the launch command: `/health` reports readiness (llama.cpp returns 503 while loading, 200 when ready) and `/v1/models` reports the served `--alias`. The alias matches back to a discovered script, so an externally started server is still attributed when its alias parses.

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
