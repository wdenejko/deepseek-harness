/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a SearXNG instance
 * (`GET {baseURL}/search?format=json`). It maps SearXNG's flat `results[]` to
 * normalized sources (`content` → `snippet`, `publishedDate` → `publishedAt`)
 * and folds any instant `answers[]` into the seam's optional `content`. SearXNG
 * is self-hosted metasearch: the request carries no credential, and the JSON
 * output format must be enabled on the instance (`search.formats: [..., json]`).
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngAnswer, SearxngError, SearxngResponse, SearxngResult } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Time-range filter values SearXNG accepts for `time_range`. */
export type SearxngTimeRange = 'day' | 'week' | 'month' | 'year'

/** Safe-search level SearXNG accepts for `safesearch` (0 off, 1 moderate, 2 strict). */
export type SearxngSafeSearch = 0 | 1 | 2

/** Resolved provider options (the plugin's `apply` supplies the env-var default). */
export interface SearxngSearchProviderOptions {
  /**
   * SearXNG instance base; `/search` is appended. An unparseable or non-http(s)
   * value makes the provider unavailable. No public default exists (every
   * SearXNG instance is self-hosted), so this must be supplied.
   */
  baseURL: string
  /** UI/engine language sent as `language` (e.g. `en`, `all`); omitted = instance default. */
  language?: string
  /** Safe-search level sent as `safesearch`; omitted = instance default. */
  safeSearch?: SearxngSafeSearch
  /** Recency window sent as `time_range`; omitted = no filter. */
  timeRange?: SearxngTimeRange
  /** Comma-separated category list sent as `categories`; omitted = instance default. */
  categories?: string
  /** Comma-separated engine list sent as `engines`; omitted = instance default. */
  engines?: string
}

/**
 * Map one SearXNG result to a normalized source, or `undefined` when it carries
 * no usable URL (a defensive drop at the JSON boundary). Unlike a highlight-only
 * provider, a snippet-less SearXNG result is still useful (URL + title), so only
 * a missing URL drops the entry.
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  if (typeof result.url !== 'string' || result.url.length === 0) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.content != null && result.content.length > 0 ? { snippet: result.content } : {},
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Join SearXNG's instant `answers[]` into one answer string, or `undefined` when
 * none are present. Tolerates both wire forms (plain string, or `{ answer }`
 * object) and a non-array `answers` field, since this is an external JSON
 * boundary; blank entries are dropped.
 *
 * @param answers - the response's `answers` field (any shape).
 * @returns the joined non-blank answers, or `undefined` when there are none.
 */
export function extractAnswers(answers: SearxngResponse['answers']): string | undefined {
  if (!Array.isArray(answers)) return undefined
  const texts = answers
    .map((answer: SearxngAnswer) => (typeof answer === 'string' ? answer : answer.answer ?? ''))
    .map(text => text.trim())
    .filter(text => text.length > 0)
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * Map a SearXNG response envelope to a normalized search result.
 *
 * @param response - the parsed JSON search response body.
 * @returns the normalized result; URL-less entries are dropped
 *   ({@link mapSearxngResult}) and instant answers become `content`.
 */
export function mapSearxngResponse(response: SearxngResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  const content = extractAnswers(response.answers)
  // The web service owns the final `maxResults` truncation, so this provider
  // reports `truncated: false`.
  return {
    ...content !== undefined ? { content } : {},
    sources,
    truncated: false,
  }
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted once
   *   at each operation's entry. A thunk rather than a value because the plugin's
   *   settings section can change between searches (the web UI edits the
   *   endpoint), and re-registering the provider to carry a new base URL would
   *   make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => SearxngSearchProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.resolveOptions().baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const params = new URLSearchParams({ q: request.query, format: 'json' })
    if (options.language !== undefined) params.set('language', options.language)
    if (options.safeSearch !== undefined) params.set('safesearch', String(options.safeSearch))
    if (options.timeRange !== undefined) params.set('time_range', options.timeRange)
    if (options.categories !== undefined) params.set('categories', options.categories)
    if (options.engines !== undefined) params.set('engines', options.engines)

    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search?${params.toString()}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `SearXNG API error (HTTP ${status})`
      try {
        const parsed = await response.json() as SearxngError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // non-JSON error body (an instance with JSON output disabled returns an
        // HTML error page) can only cost a richer message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngResponse
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True when `baseURL` parses as an absolute http(s) URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  if (!URL.canParse(baseURL)) return false
  const { protocol } = new URL(baseURL)
  return protocol === 'http:' || protocol === 'https:'
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
