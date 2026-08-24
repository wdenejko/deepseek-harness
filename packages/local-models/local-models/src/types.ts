/**
 * Vocabulary for the local-model lifecycle seam (`ctx.localModels`): the
 * discovered per-script catalog, its run-state, the llm selection a started
 * server routes to, and the endpoint probe result. Types only — the SSH
 * transport and orchestration live in `./ssh.ts` and `./index.ts`.
 *
 * These are the domain wire types: the `localModels.*` Host RPC domain imports
 * them type-only, and the web client reads them re-exported from the Host
 * contract, so this module is the single home for the shape.
 *
 * @module @deepseek-ai/dsh-local-models/types
 */

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A local model server's lifecycle changed — a start was launched or a stop
     * ran. Consumers refetch the catalog; the payload-free nudge mirrors
     * `llm/adapters-updated`.
     * @mode emit
     */
    'localModels/state-changed'(): void
  }
}

/**
 * Lifecycle state of one local model server as the seam reports it:
 * `running` (its `/health` is up and it is the server on the probe port),
 * `starting` (a start was launched and readiness has not yet been observed,
 * within the start budget), or `stopped` (neither).
 */
export type LocalModelRunState = 'running' | 'starting' | 'stopped'

/** The llm selection a started local server routes turns to. */
export interface LocalModelRoute {
  /** Registered llm provider route (the single local endpoint route). */
  provider: string
  /** Provider-owned model id accepted by that route. */
  model: string
}

/**
 * One local model server, keyed by its run-script slug. `llama-server` serves
 * one model and ignores the requested model id, so `id` is a lifecycle handle
 * (which script to launch), not an llm-routing distinction — every entry routes
 * to the catalog's single {@link LocalModelRoute}.
 */
export interface LocalModelEntry {
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

/**
 * The discovered local catalog plus which entry currently serves the probe
 * endpoint. `running` is the entry id, or null when the endpoint is down or
 * serving a model this seam cannot attribute to a known script.
 */
export interface LocalModelCatalog {
  /** The llm provider id whose dropdown group this catalog supersedes. */
  providerId: string
  /** The llm selection to activate once a server is up. */
  route: LocalModelRoute
  /** Entry id currently serving the probe endpoint, or null. */
  running: string | null
  /** Every discovered run script (`.bak` excluded), with per-entry run-state. */
  models: readonly LocalModelEntry[]
}

/**
 * Result of probing the model endpoint: whether `/health` is up and the model
 * id `/v1/models` reports serving (the running `--alias`), or null when the
 * endpoint is down or its model list is unreadable.
 */
export interface LocalModelStatus {
  /** The `id` from `/v1/models` (the running `--alias`), or null. */
  runningAlias: string | null
  /** True when `/health` returned 200. */
  healthy: boolean
}
