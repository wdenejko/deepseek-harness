/**
 * `@deepseek-ai/dsh-local-models`: the `ctx.localModels` capability seam and its
 * single SSH implementation. It discovers the run scripts on a remote host,
 * reports which model server is up, and starts/stops them so the model dropdown
 * can list every local model, show the running one, and switch between them.
 *
 * `llama-server` serves one model at a time on the probe port and ignores the
 * requested model id, so starting a model is "make it the one running"; the
 * seam holds a launched-but-not-yet-ready model as `starting` for the start
 * budget, computed from a timestamp rather than a background timer. A start or
 * stop emits `localModels/state-changed`; consumers refetch the catalog.
 *
 * This is a service package: it default-exports the service class, which
 * registers as `ctx.localModels`. It is opt-in — mount it (with the remote
 * host's config) only where a workstation drives remote model servers.
 *
 * @module @deepseek-ai/dsh-local-models
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  createSubprocessRunner, discover, isSafeId, localModelDisplayName, probeStatus, startScript, stopServer,
} from './ssh.ts'
import type { DiscoveredScript, RemoteRunner } from './ssh.ts'
import type { LocalModelCatalog, LocalModelEntry, LocalModelRoute, LocalModelRunState, LocalModelStatus } from './types.ts'

export type {
  LocalModelCatalog, LocalModelEntry, LocalModelRoute, LocalModelRunState, LocalModelStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Lifecycle control for remote local-model servers (opt-in). */
    localModels: LocalModelManager
  }
}

/** Settings namespace carrying the remote host and endpoint config. */
export const LOCAL_MODELS_SETTINGS_NAMESPACE = settingsNamespace('local-models')

/** Plugin config: the remote host, the model endpoint, and the llm route a started server serves. */
export interface Config {
  /** SSH destination of the host running the model servers (e.g. an `ssh_config` host alias). */
  sshTarget: string
  /** Directory of the `run-*.sh` launch scripts on the remote host; a leading `~` expands there. */
  scriptsDir: string
  /** Base URL of the model endpoint, probed for `/health` and `/v1/models`. */
  probeBaseURL: string
  /** The llm provider id whose dropdown group this seam supersedes. */
  providerId: string
  /** The llm selection to activate once a local server is up. */
  route: LocalModelRoute
  /** Local executable that reaches the remote host (default `ssh`). */
  execCommand?: string
  /** Remote command that stops the running server (default `pkill -f llama-server`). */
  stopCommand?: string
  /** How long a launched-but-unready model reads as `starting` before reverting to `stopped`. */
  startTimeoutMs?: number
  /** Per-request timeout for each endpoint probe. */
  probeTimeoutMs?: number
  /** SIGTERM→SIGKILL grace for the local `ssh` child. */
  graceMs?: number
}

/** The config shape after schemastery applied the field defaults. */
type ResolvedConfig = Required<Config>

/**
 * SSH-backed local-model lifecycle manager. Discovery and start/stop each run
 * one remote command; run-state comes from probing the model endpoint. One
 * model runs at a time, so `start` stops the current server first.
 */
export class LocalModelManager extends Service {
  static inject = ['subprocess']

  // The remote host, endpoint, and route are required (the seam cannot act
  // without them); the rest are deployment-varying knobs with defaults.
  static Config: z<Config> = z.object({
    sshTarget: z.string().required(),
    scriptsDir: z.string().required(),
    probeBaseURL: z.string().required(),
    providerId: z.string().required(),
    route: z.object({
      provider: z.string().required(),
      model: z.string().required(),
    }).required(),
    execCommand: z.string().default('ssh'),
    stopCommand: z.string().default('pkill -f llama-server'),
    startTimeoutMs: z.number().default(180_000),
    probeTimeoutMs: z.number().default(5_000),
    graceMs: z.number().default(5_000),
  })

  /** The currently authoritative config: the settings section, or the composition entry. */
  private source: () => ResolvedConfig

  /** Remote command runner over `ctx.subprocess`. */
  private readonly runner: RemoteRunner

  /** The model whose start was launched but whose readiness has not yet been observed. */
  private pending: { id: string; startedAt: number } | null = null

  /** The last model this seam launched — the running attribution when the served alias is not parseable. */
  private lastStartedId: string | null = null

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedConfig {
    return this.source()
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'localModels')
    // Schemastery fills the defaulted fields before construction; the type does not encode that step.
    const entry = config as ResolvedConfig
    this.source = () => entry
    installSettingsSection(ctx, LOCAL_MODELS_SETTINGS_NAMESPACE, LocalModelManager.Config, entry, {
      setSource: (current) => {
        this.source = current as () => ResolvedConfig
      },
      // Every field is read through the getter per operation, so nothing derived
      // needs rebuilding when the settings document changes.
      onChange: () => {},
    })
    this.runner = createSubprocessRunner(ctx, () => this.config.graceMs)
  }

  /**
   * Discover the remote run scripts and fold in current run-state.
   * @param signal - aborts discovery and the endpoint probe.
   * @returns the local catalog with the running entry and per-entry state.
   */
  async list(signal?: AbortSignal): Promise<LocalModelCatalog> {
    const cfg = this.config
    const [scripts, status] = await Promise.all([
      discover(this.runner, cfg, signal),
      probeStatus(cfg, signal),
    ])
    const running = this.settleRunning(scripts, status)
    return {
      providerId: cfg.providerId,
      route: cfg.route,
      running,
      models: scripts.map(script => this.toEntry(script, running)),
    }
  }

  /**
   * Probe the model endpoint directly.
   * @param signal - aborts the probe.
   * @returns the endpoint's health and served model id.
   */
  async status(signal?: AbortSignal): Promise<LocalModelStatus> {
    return probeStatus(this.config, signal)
  }

  /**
   * Make one model the server running on the endpoint: stop the current server
   * (only one fits), launch the requested script detached, and mark it
   * `starting`. Readiness is observed by a later {@link list}/{@link status}.
   * @param id - script slug to start.
   * @param signal - aborts the stop/launch commands (not the launched server).
   * @throws Error for an unknown/unsafe id, an SSH failure, or a non-zero remote exit.
   */
  async start(id: string, signal?: AbortSignal): Promise<void> {
    if (!isSafeId(id)) throw new Error(`local-models: unknown or unsafe model id: ${id}`)
    const cfg = this.config
    const status = await probeStatus(cfg, signal)
    if (status.healthy) await stopServer(this.runner, cfg, signal)
    await startScript(this.runner, cfg, id, signal)
    this.pending = { id, startedAt: Date.now() }
    this.lastStartedId = id
    this.ctx.emit('localModels/state-changed')
  }

  /**
   * Stop the running model server, freeing the endpoint and the accelerator.
   * @param signal - aborts the stop command.
   * @throws Error on an SSH failure or a stop-command exit other than success/no-match.
   */
  async stop(signal?: AbortSignal): Promise<void> {
    await stopServer(this.runner, this.config, signal)
    this.pending = null
    this.lastStartedId = null
    this.ctx.emit('localModels/state-changed')
  }

  /** Resolve the running entry id and retire a fulfilled or timed-out pending start. */
  private settleRunning(scripts: readonly DiscoveredScript[], status: LocalModelStatus): string | null {
    const running = this.resolveRunning(scripts, status)
    if (this.pending !== null) {
      const expired = Date.now() - this.pending.startedAt >= this.config.startTimeoutMs
      if (running === this.pending.id || expired) this.pending = null
    }
    return running
  }

  /** The running entry id: the served alias matched to a script, else the last model this seam started. */
  private resolveRunning(scripts: readonly DiscoveredScript[], status: LocalModelStatus): string | null {
    if (!status.healthy) return null
    if (status.runningAlias !== null) {
      const matched = scripts.find(script => script.alias === status.runningAlias)
      if (matched !== undefined) return matched.id
    }
    return this.pending?.id ?? this.lastStartedId
  }

  /** Project one discovered script into a catalog entry with its resolved run-state. */
  private toEntry(script: DiscoveredScript, running: string | null): LocalModelEntry {
    return {
      id: script.id,
      name: localModelDisplayName(script),
      ...script.alias !== undefined ? { alias: script.alias } : {},
      ...script.description !== undefined ? { description: script.description } : {},
      scriptPath: script.scriptPath,
      runState: this.runStateFor(script, running),
    }
  }

  /** Running when it serves the endpoint, starting while its launch is live, else stopped. */
  private runStateFor(script: DiscoveredScript, running: string | null): LocalModelRunState {
    if (script.id === running) return 'running'
    // settleRunning already retired an expired or fulfilled pending, so a
    // surviving pending is a live launch of this script.
    if (this.pending?.id === script.id) return 'starting'
    return 'stopped'
  }
}

export default LocalModelManager
