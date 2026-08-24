/**
 * localModels domain contract. Method signatures are the source of truth:
 * unary methods take the RpcRequest<P> narrow form and the impl echoes rpcId.
 *
 * Lifecycle control for the optional `ctx.localModels` seam. `list` returns a
 * `null` catalog when the seam is not mounted (the opt-in-absent signal the web
 * client reads to hide the section); transport failures surface as the
 * `local-models-error` branch. `start`/`stop` are launch/kill acknowledgements
 * — the resulting run-state is observed by the next `list`, and a start or stop
 * also emits `localModels/state-changed` so every client refetches.
 */

import type { LocalModelCatalog } from '@deepseek-ai/dsh-local-models/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

export type { LocalModelCatalog, LocalModelEntry, LocalModelRoute, LocalModelRunState } from '@deepseek-ai/dsh-local-models/types'

/** localModels-domain unary methods. */
export interface LocalModelsApi {
  /** Discover the local model catalog with per-entry run-state; `catalog` is null when the seam is not mounted. */
  list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<{ catalog: LocalModelCatalog | null }>>

  /** Make one model the running server (stops the current one first); acknowledges the launch, not readiness. */
  start(request: RpcRequest<{ id: string }>): Promise<RpcResponse<{ ok: true }>>

  /** Stop the running model server. */
  stop(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<{ ok: true }>>
}
