/** The SearXNG search card's staged form over the `web-search-searxng` settings namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, numberField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the SearXNG search provider. Spelled here rather than imported: a
 * client package must not depend on a Host package, and the provider that owns
 * it spells the same value.
 */
export const SEARXNG_NS = 'web-search-searxng'

/** The SearXNG fields this card edits — a subset of the served schema by design. */
export interface SearxngSettings {
  /** SearXNG instance base URL; blank falls back to the provider's env default. */
  baseURL?: string
  /** UI/engine language sent as `language` (e.g. `en`, `all`). */
  language?: string
  /** Safe-search level sent as `safesearch`: 0 off, 1 moderate, 2 strict. */
  safeSearch?: number
  /** Comma-separated engine list sent as `engines` (e.g. `google,bing`). */
  engines?: string
}

/** What the SearXNG card renders. */
export interface SearxngCardState extends CardShell {
  /** SearXNG instance base URL. */
  baseURL: CardFieldState
  /** UI/engine language. */
  language: CardFieldState
  /** Safe-search level (0 off, 1 moderate, 2 strict). */
  safeSearch: CardFieldState
  /** Comma-separated engine list. */
  engines: CardFieldState
}

/** The registration-side face the SearXNG card's slot entry injects. */
export interface SearxngCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useSearxngCard. */
    searxngCard: SnapshotStore<SearxngCardState>
  }
}

/** Bridges the `web-search-searxng` scope onto the SearXNG card's staged form. */
export class SearxngCardController {
  private readonly form: CardForm<SearxngSettings>
  private readonly store: SnapshotStore<SearxngCardState>

  /** @param scope - the bound settings scope for the `web-search-searxng` namespace. */
  constructor(scope: SettingsScope<SearxngSettings>) {
    this.form = new CardForm(scope, [
      textField('baseURL'),
      textField('language'),
      numberField('safeSearch'),
      textField('engines'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SearxngCardState {
    return {
      ...this.form.shell(),
      baseURL: this.form.field('baseURL'),
      language: this.form.field('language'),
      safeSearch: this.form.field('safeSearch'),
      engines: this.form.field('engines'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): SearxngCardFace {
    return { hooks: { searxngCard: this.store }, ...this.form.actions() }
  }
}
