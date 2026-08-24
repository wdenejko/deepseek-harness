/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and the composer-seat selector load through the same
 * controller and submit through the same selectModel call, so the host stays
 * the single fact source and the store is one shared echo — a switch made in
 * either entry is what the other shows next.
 */
import type {
  IApiClient, LocalModelCatalog, ModelCatalogFailure, ModelProviderGroup, ModelSelection,
  SessionId, SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Model selection the host reports for the next assembled step; null before the first load. */
  current: ModelSelection | null
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
  /**
   * The discovered local-model catalog with per-entry run-state, or null when
   * no `ctx.localModels` seam is mounted (the dropdown then shows no local
   * section). Loaded and refreshed independently of the llm catalog.
   */
  local: LocalModelCatalog | null
  /** Local start/stop/list failure text; null when none. */
  localError: string | null
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
    local: null, localError: null,
  })

  /** Latest operation wins; an older response never overwrites a newer one. */
  private generation = 0
  /** Independent latest-wins guard for the local catalog (its own load/start/stop axis). */
  private localGeneration = 0
  private disposed = false

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param localModels - the host local-model lifecycle wire face.
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   */
  constructor(
    private readonly sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'>,
    private readonly localModels: Pick<IApiClient['localModels'], 'list' | 'start' | 'stop'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
  ) {}

  /**
   * Refresh the advisory directory (both entries call this on open).
   * Failure preserves the last good groups and current selection.
   * @returns the fresh directory value.
   */
  async load(): Promise<SessionModels> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    const { result } = await this.sessions.models({ sessionId: this.sessionId })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`)
    }
    const { current, routable, groups, failures } = result.value
    this.store.update((s) => {
      s.current = current
      s.routable = routable
      s.groups = groups
      s.failures = failures
      s.status = 'ready'
      s.error = null
    })
    return result.value
  }

  /**
   * Select the complete provider/model/reasoning selection (both entries submit through here). Success
   * updates the shared current; failure surfaces on the store and throws so
   * each entry's own retry surface engages.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
 */
  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.error = null })
    const { result } = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    // The Host validated the route before accepting it, so a selection that
    // landed is by construction one it can serve.
    this.store.update((s) => {
      s.current = result.value.selected
      s.routable = true
      s.status = 'ready'
      s.error = null
    })
  }

  /**
   * Refresh the local-model catalog (independent of the llm catalog and of
   * session availability — the seam is host-global). A null catalog means no
   * seam is mounted. Failure preserves the last good catalog.
   */
  async loadLocal(): Promise<void> {
    const generation = ++this.localGeneration
    const { result } = await this.localModels.list({})
    if (this.disposed || generation !== this.localGeneration) return
    if (!result.ok) {
      this.store.update((s) => { s.localError = `${result.error.code}: ${result.error.message}` })
      return
    }
    this.store.update((s) => { s.local = result.value.catalog; s.localError = null })
  }

  /**
   * Make one local model the running server and route the session to it. Only
   * one model serves at a time, so the host stops the current one first; the
   * chosen model reads as `starting` until a later {@link loadLocal} sees it up.
   * @param id - the local model (run-script slug) to start.
   * @returns whether the start was accepted.
   */
  async startLocal(id: string): Promise<boolean> {
    const local = this.store.getSnapshot().local
    if (local === null) return false
    const generation = ++this.localGeneration
    this.store.update((s) => {
      if (s.local === null) return
      s.local = { ...s.local, running: null, models: s.local.models.map(model => ({ ...model, runState: model.id === id ? 'starting' : 'stopped' })) }
      s.localError = null
    })
    const { result } = await this.localModels.start({ id })
    if (this.disposed || generation !== this.localGeneration) return result.ok
    if (!result.ok) {
      this.store.update((s) => { s.localError = `${result.error.code}: ${result.error.message}` })
      await this.loadLocal()
      return false
    }
    // Point the session at the local route so the next turn reaches the endpoint
    // this model now serves; the Host validated the route, so this only fails
    // for an unrelated reason, which surfaces on the store.
    if (this.available()) await this.select(local.route).catch(() => undefined)
    await this.loadLocal()
    return true
  }

  /**
   * Stop the running local model server, freeing the endpoint and accelerator.
   * @returns whether the stop was accepted.
   */
  async stopLocal(): Promise<boolean> {
    if (this.store.getSnapshot().local === null) return false
    const generation = ++this.localGeneration
    this.store.update((s) => {
      if (s.local === null) return
      s.local = { ...s.local, running: null, models: s.local.models.map(model => ({ ...model, runState: 'stopped' })) }
      s.localError = null
    })
    const { result } = await this.localModels.stop({})
    if (this.disposed || generation !== this.localGeneration) return result.ok
    if (!result.ok) {
      this.store.update((s) => { s.localError = `${result.error.code}: ${result.error.message}` })
      await this.loadLocal()
      return false
    }
    await this.loadLocal()
    return true
  }

  /**
   * Drop the previous Host generation's projection and repull it. Clearing
   * first prevents an unconsumed process-local selection from being displayed
   * while the restarted Host has restored the last logged model selection.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    ++this.localGeneration
    this.store.update((s) => {
      s.current = null
      s.routable = null
      s.groups = []
      s.failures = []
      s.status = 'idle'
      s.error = null
      s.local = null
      s.localError = null
    })
    if (!this.available()) return
    void this.load().catch(() => { /* the next menu open remains the explicit retry surface */ })
    void this.loadLocal().catch(() => { /* the next menu open remains the explicit retry surface */ })
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }
}
