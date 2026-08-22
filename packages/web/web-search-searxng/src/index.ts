/**
 * `@deepseek-ai/dsh-web-search-searxng`: registers a SearXNG-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key — it
 * registers INTO the seam's provider registry, exactly as
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`. The key
 * is owned by `@deepseek-ai/dsh-web`.
 *
 * When a settings service is present, the provider's endpoint and query knobs
 * are an editable settings section (`web-search-searxng`): the provider projects
 * the resolved section per search, so an endpoint changed from the web UI
 * reaches the next search with no re-registration.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { SearxngSearchProvider } from './provider.ts'
import type { SearxngSafeSearch, SearxngSearchProviderOptions, SearxngTimeRange } from './provider.ts'

export {
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from './provider.ts'
export type {
  SearxngSafeSearch,
  SearxngSearchProviderOptions,
  SearxngTimeRange,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Environment variable naming the SearXNG instance base URL. */
const SEARXNG_BASE_URL_ENV = 'SEARXNG_BASE_URL'

/** Settings namespace carrying this provider's endpoint and query knobs. */
export const WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE = settingsNamespace('web-search-searxng')

/** Plugin config (all optional — `apply` fills the env-var default). */
export interface Config {
  /**
   * SearXNG instance base; `/search` is appended. Falls back to
   * `$SEARXNG_BASE_URL`. Absent/unparseable → provider unavailable.
   */
  baseURL?: string
  /** UI/engine language sent as `language` (e.g. `en`, `all`). Omitted = instance default. */
  language?: string
  /** Safe-search level sent as `safesearch` (0 off, 1 moderate, 2 strict). Omitted = instance default. */
  safeSearch?: SearxngSafeSearch
  /** Recency window sent as `time_range`. Omitted = no filter. */
  timeRange?: SearxngTimeRange
  /** Comma-separated category list sent as `categories`. Omitted = instance default. */
  categories?: string
  /** Comma-separated engine list sent as `engines`. Omitted = instance default. */
  engines?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  language: z.string(),
  safeSearch: z.union([0, 1, 2] as const),
  timeRange: z.union(['day', 'week', 'month', 'year'] as const),
  categories: z.string(),
  engines: z.string(),
})

/**
 * Project one resolved section into the options the provider serves its next
 * search with. The `$SEARXNG_BASE_URL` fallback stays here so the provider reads
 * a single already-resolved base URL.
 * @param ctx - plugin context supplying the launch environment.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): SearxngSearchProviderOptions {
  return {
    // The base URL is not a secret: the product trusts the project it is
    // launched in, and the managed credential store is not involved here.
    baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(SEARXNG_BASE_URL_ENV)?.value ?? '',
    ...config.language !== undefined ? { language: config.language } : {},
    ...config.safeSearch !== undefined ? { safeSearch: config.safeSearch } : {},
    ...config.timeRange !== undefined ? { timeRange: config.timeRange } : {},
    ...config.categories !== undefined ? { categories: config.categories } : {},
    ...config.engines !== undefined ? { engines: config.engines } : {},
  }
}

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  installSettingsSection(ctx, WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new SearxngSearchProvider(() => resolveOptions(ctx, current())))
}
