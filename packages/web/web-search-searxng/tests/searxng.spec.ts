import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { SearxngSearchProvider, SEARXNG_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-searxng'
import type { SearxngSearchProviderOptions } from '@deepseek-ai/dsh-web-search-searxng'
import * as searxngPlugin from '@deepseek-ai/dsh-web-search-searxng'
import { extractAnswers, mapSearxngResponse, mapSearxngResult } from '../src/provider.ts'

const BASE_URL = 'https://searx.test'
const options = { baseURL: BASE_URL }

/** Construct a provider from a fixed options snapshot (the thunk pattern's simplest caller). */
function mk(providerOptions: SearxngSearchProviderOptions): SearxngSearchProvider {
  return new SearxngSearchProvider(() => providerOptions)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** Parse the URL passed to a stubbed `fetch` call (by 0-based call index). */
function calledUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): URL {
  const [url] = fetchMock.mock.calls[index] as unknown as [string]
  return new URL(url)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SearXNG result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapSearxngResult({
      url: 'https://a.test',
      title: 'A',
      content: 'a snippet',
      publishedDate: '2026-01-01T00:00:00',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'a snippet', publishedAt: '2026-01-01T00:00:00' })
  })

  it('keeps a snippet-less result (URL + title still useful)', () => {
    expect(mapSearxngResult({ url: 'https://a.test', title: 'A' })).toEqual({ url: 'https://a.test', title: 'A' })
  })

  it('drops a result with no usable URL', () => {
    expect(mapSearxngResult({ url: '' })).toBeUndefined()
    expect(mapSearxngResult({} as never)).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapSearxngResult({ url: 'https://a.test', title: null, content: '', publishedDate: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test', title: '', content: null, publishedDate: '' }))
      .toEqual({ url: 'https://a.test' })
  })
})

describe('SearXNG answer extraction', () => {
  it('joins plain-string answers', () => {
    expect(extractAnswers(['first', 'second'])).toBe('first\nsecond')
  })

  it('joins object answers by their answer field', () => {
    expect(extractAnswers([{ answer: 'x' }, { answer: 'y' }])).toBe('x\ny')
  })

  it('mixes forms and drops blank/empty entries', () => {
    expect(extractAnswers(['a', { answer: '' }, { answer: 'b' }, '  ', {}])).toBe('a\nb')
  })

  it('returns undefined for an empty or non-array answers field', () => {
    expect(extractAnswers([])).toBeUndefined()
    expect(extractAnswers(undefined)).toBeUndefined()
    expect(extractAnswers({} as never)).toBeUndefined()
  })
})

describe('SearXNG response mapping', () => {
  it('maps sources and folds answers into content', () => {
    const result = mapSearxngResponse({
      results: [
        { url: 'https://a.test', content: 'one' },
        { url: '', content: 'dropped' },
        { url: 'https://c.test', title: 'C' },
      ],
      answers: ['the answer'],
    })
    expect(result).toEqual({
      content: 'the answer',
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C' },
      ],
      truncated: false,
    })
  })

  it('omits content when there are no answers', () => {
    const result = mapSearxngResponse({ results: [{ url: 'https://a.test' }] })
    expect(result.content).toBeUndefined()
    expect(result).toEqual({ sources: [{ url: 'https://a.test' }], truncated: false })
  })

  it('tolerates a missing results array', () => {
    expect(mapSearxngResponse({}).sources).toEqual([])
  })
})

describe('SearxngSearchProvider availability', () => {
  it('is available with a parseable http(s) base URL (no key needed)', () => {
    expect(mk(options).available()).toBe(true)
    expect(mk({ baseURL: 'http://localhost:8080' }).available()).toBe(true)
  })

  it('is unavailable without a base URL', () => {
    expect(mk({ baseURL: '' }).available()).toBe(false)
  })

  it('is unavailable for an unparseable or non-http(s) base URL', () => {
    expect(mk({ baseURL: 'not a url' }).available()).toBe(false)
    expect(mk({ baseURL: 'ftp://searx.test' }).available()).toBe(false)
  })
})

describe('SearxngSearchProvider request mapping', () => {
  it('sends q, format=json and a GET with redirect rejection', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await mk(options).search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const url = calledUrl(fetchMock)
    expect(`${url.origin}${url.pathname}`).toBe('https://searx.test/search')
    expect(url.searchParams.get('q')).toBe('hello')
    expect(url.searchParams.get('format')).toBe('json')
    // SearXNG has no result-count param; the seam enforces maxResults on return.
    expect([...url.searchParams.keys()]).toEqual(['q', 'format'])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
  })

  it('threads configured query knobs into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await mk({
      baseURL: BASE_URL,
      language: 'en',
      safeSearch: 1,
      timeRange: 'week',
      categories: 'general',
      engines: 'google,bing',
    }).search({ query: 'q' })

    const url = calledUrl(fetchMock)
    expect(url.searchParams.get('language')).toBe('en')
    expect(url.searchParams.get('safesearch')).toBe('1')
    expect(url.searchParams.get('time_range')).toBe('week')
    expect(url.searchParams.get('categories')).toBe('general')
    expect(url.searchParams.get('engines')).toBe('google,bing')
  })

  it('omits unset query knobs', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await mk(options).search({ query: 'q' })
    const url = calledUrl(fetchMock)
    for (const key of ['language', 'safesearch', 'time_range', 'categories', 'engines']) {
      expect(url.searchParams.has(key)).toBe(false)
    }
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await mk(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('re-reads options per search so a settings change takes effect live', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    let baseURL = 'https://one.searx.test'
    const provider = new SearxngSearchProvider(() => ({ baseURL }))
    await provider.search({ query: 'q' })
    baseURL = 'https://two.searx.test'
    await provider.search({ query: 'q' })
    expect(calledUrl(fetchMock, 0).origin).toBe('https://one.searx.test')
    expect(calledUrl(fetchMock, 1).origin).toBe('https://two.searx.test')
  })
})

describe('SearxngSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'format not enabled' }, { status: 403 })))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'format not enabled' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>forbidden</html>', { status: 403 })))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG API error (HTTP 403)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(mk(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-searxng plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    const fiber = await ctx.plugin(searxngPlugin, { baseURL: BASE_URL })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in searxngPlugin).toBe(false)
  })

  it('threads query-knob config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    const fiber = await ctx.plugin(searxngPlugin, {
      baseURL: BASE_URL, language: 'en', safeSearch: 2, timeRange: 'month', categories: 'news', engines: 'google',
    })
    await ctx.web.search({ query: 'q' })
    const url = calledUrl(fetchMock)
    expect(url.searchParams.get('language')).toBe('en')
    expect(url.searchParams.get('safesearch')).toBe('2')
    expect(url.searchParams.get('time_range')).toBe('month')
    expect(url.searchParams.get('categories')).toBe('news')
    expect(url.searchParams.get('engines')).toBe('google')
    await fiber.dispose()
  })

  it('falls back to $SEARXNG_BASE_URL when config omits baseURL', async () => {
    const prev = process.env.SEARXNG_BASE_URL
    process.env.SEARXNG_BASE_URL = 'https://env.searx.test'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
      const fiber = await ctx.plugin(searxngPlugin, {})
      await ctx.web.search({ query: 'q' })
      expect(calledUrl(fetchMock).origin).toBe('https://env.searx.test')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.SEARXNG_BASE_URL
      else process.env.SEARXNG_BASE_URL = prev
    }
  })

  it('is unavailable when neither config nor env supplies a base URL', async () => {
    const prev = process.env.SEARXNG_BASE_URL
    delete process.env.SEARXNG_BASE_URL
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
      await ctx.plugin(searxngPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (prev !== undefined) process.env.SEARXNG_BASE_URL = prev
    }
  })
})
