# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

A [SearXNG](https://github.com/searxng/searxng)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls a self-hosted SearXNG instance's `GET /search?format=json` endpoint and maps the flat `results[]` into the seam's normalized `WebSearchResult`, folding any instant `answers[]` into `content`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

SearXNG is the shipped default search provider in [`dsh-base`](../../bundle/base/README.md); it becomes usable once `SEARXNG_BASE_URL` (or a configured `baseURL`) points at a JSON-enabled instance.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL` | SearXNG instance base; `/search` is appended. Absent, unparseable, or non-`http(s)` makes the provider unavailable. |
| `language` | (instance default) | UI/engine language sent as `language` (e.g. `en`, `all`). |
| `safeSearch` | (instance default) | Safe-search level sent as `safesearch`: `0` off, `1` moderate, `2` strict. |
| `timeRange` | (unset) | Recency window sent as `time_range`: `day`, `week`, `month`, or `year`. Unset sends no filter. |
| `categories` | (instance default) | Comma-separated category list sent as `categories` (e.g. `general,news`). |
| `engines` | (instance default) | Comma-separated engine list sent as `engines` (e.g. `google,bing`). |

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: !!js process.env.SEARXNG_BASE_URL
```

> The instance **must enable JSON output** (`search.formats` includes `json` in its `settings.yml`). A default install often ships HTML-only; a JSON request then returns an HTML error page, which surfaces as `WEB_PROVIDER_ERROR`.

When a settings service is present, these fields are an editable settings section (`web-search-searxng`), and the web app ships a **Web search** card (`@deepseek-ai/dsh-client-ui-settings-plugins`) that edits the endpoint (`baseURL`) plus the `language`, `safeSearch`, and `engines` knobs. The provider projects the resolved section per search, so a value changed from the UI reaches the next search with no restart.

## Mapping

The provider issues `GET {baseURL}/search?q=<query>&format=json`, adding `language`/`safesearch`/`time_range`/`categories`/`engines` when configured. Each `results[]` entry maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `content`, `publishedAt` ← `publishedDate`. An entry with no URL is dropped; a snippet-less entry is kept (URL and title are still useful). Instant `answers[]` (plain strings or `{ answer }` objects, tolerated across SearXNG versions) are joined into the result's `content`. SearXNG has no result-count parameter (it paginates via `pageno`), so `maxResults` is not sent and the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, snippets, and publication dates plus any instant-answer text as the search answer, or its exact `SearXNG search aborted`, `SearXNG search request failed: <error>`, and `SearXNG returned an unprocessable response body: <error>` failures under the consumer's error wrapper. Provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **JSON output must be enabled on the instance** — without `json` in the instance's `search.formats`, requests fail as `WEB_PROVIDER_ERROR`; the provider cannot enable it remotely.
- **Single page only** — SearXNG paginates via `pageno`; this provider fetches one page, so fewer than the requested count can return. Multi-page accumulation waits on a demonstrated need.
- **Open instances only** — an instance behind HTTP Basic auth, a token, or a bot wall is unsupported; credential handling waits on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
