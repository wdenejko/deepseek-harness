/**
 * Wire types for the SearXNG JSON search API (`GET {baseURL}/search?format=json`).
 * Types only — no runtime code. SearXNG returns a flat `results[]`; each entry
 * carries a URL, optional title, optional `content` (the snippet), and an
 * optional `publishedDate`. Instant `answers[]` vary by SearXNG version: older
 * builds emit plain strings, newer builds emit objects carrying an `answer`
 * field, so both forms are modeled.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's flat `results[]`. */
export interface SearxngResult {
  url: string
  title?: string | null
  /** The result snippet SearXNG names `content`. */
  content?: string | null
  /** Publication/crawl date, present only for some engines. */
  publishedDate?: string | null
}

/**
 * One entry of SearXNG's `answers[]`. A plain string on older instances; an
 * object carrying `answer` on newer ones. Other object fields (`url`, `engine`,
 * …) are ignored.
 */
export type SearxngAnswer = string | { answer?: string | null }

/** SearXNG's JSON search response envelope. */
export interface SearxngResponse {
  results?: SearxngResult[]
  /** Instant answers (calculations, definitions, …), when any engine returned one. */
  answers?: SearxngAnswer[]
}

/** SearXNG's error response envelope (best-effort; fields vary by failure and proxy). */
export interface SearxngError {
  error?: string
  message?: string
}
