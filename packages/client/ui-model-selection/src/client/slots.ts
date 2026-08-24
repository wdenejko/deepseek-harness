/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from './directory.ts'

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Refresh the advisory directory and the local catalog (fire-and-forget; errors land on the store). */
  load: () => void
  /** Refresh only the local-model catalog (used to poll a starting model to running). */
  loadLocal: () => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
  /**
   * Start one local model (making it the running server) and route the session to it.
   * @param id - the local model (run-script slug) to start.
   * @returns whether the start was accepted.
   */
  startLocal: (id: string) => Promise<boolean>
  /**
   * Stop the running local model server.
   * @returns whether the stop was accepted.
   */
  stopLocal: () => Promise<boolean>
}
