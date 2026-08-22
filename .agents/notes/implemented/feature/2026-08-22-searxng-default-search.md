# Agent Note: SearXNG as the shipped default search provider

Status: implemented

English | [中文](2026-08-22-searxng-default-search.zh.md)

## Problem

The shipped default `web_search` was backed by `deepseek-official`, which performs an auxiliary DeepSeek Messages call with the native server tool on every search — a full model turn, billed, reusing `DEEPSEEK_API_KEY` ([default-search decision](2026-07-31-web-default-search.md)). A deployment that prefers a self-hosted, operator-controlled metasearch engine with no per-search model cost had to write its own overlay, and the harness shipped no provider for one. [SearXNG](https://github.com/searxng/searxng) is that engine, but its only structured API is `GET /search?format=json`; it has no content-fetch API, so it fits the search-provider role only.

## Decision

A new implementation package `@deepseek-ai/dsh-web-search-searxng` registers a `searxng` `WebSearchProvider` into `ctx.web`, exactly as the other search backends do. `dsh-base` mounts it and sets `web.searchProvider: searxng`, replacing the `web-search-deepseek` row; the `dsh-tool-web` `searchTimeoutMs: 60000` override is dropped so the provider-neutral 30-second default applies, because a SearXNG search is a single fast metasearch HTTP call rather than an auxiliary model request. No fetch provider is added: fetch is already provider-neutral (`web-fetch-http`) and SearXNG offers no fetch API.

The provider issues `GET {baseURL}/search?q=<query>&format=json`, adding configured `language`/`safesearch`/`time_range`/`categories`/`engines`. It maps each `results[]` entry to a source (`content` → `snippet`, `publishedDate` → `publishedAt`, URL-less entries dropped, snippet-less entries kept) and folds instant `answers[]` (string or `{ answer }` object, tolerated across versions) into the seam's optional `content`. `maxResults` is not sent — SearXNG paginates via `pageno`, so the seam owns the final bound. `baseURL` comes from config or `$SEARXNG_BASE_URL`; the provider is unavailable until one names a parseable `http(s)` instance, so an unset base fails a configured selection with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, the same fail-loud shape the DeepSeek route has without its key. The instance must have JSON output enabled (`search.formats` includes `json`); an HTML-only instance returns an error page that surfaces as `WEB_PROVIDER_ERROR`.

SearXNG instances are reached without credentials, so the provider carries no key. Its endpoint and query knobs are an editable settings section (`web-search-searxng`) projected per search, so an endpoint changed from the web UI reaches the next search with no re-registration; `@deepseek-ai/dsh-client-ui-settings-plugins` ships a Web search card that edits the endpoint (`baseURL`) plus the `language`, `safeSearch`, and `engines` knobs. Requests set `redirect: 'error'` for parity with the credentialed providers.

## Alternatives considered

**Keep DeepSeek as the default and ship SearXNG opt-in only.** Rejected: the request was to make SearXNG the default; an opt-in provider beside the existing three would not change the shipped experience.

**Mount both providers and select `searxng`.** Rejected: the seam would resolve correctly (explicit id wins), but the shipped web UI's served-namespace-gated "Web Search" settings card is DeepSeek-shaped (an API key over the `web-search-deepseek` namespace). Leaving it mounted would present a DeepSeek key form while SearXNG is the actual default — a misleading config surface. Full replacement makes the shipped state honest; DeepSeek search stays one config line away.

**Build a SearXNG fetch provider too.** Rejected: SearXNG has no content-fetch API, and `web_fetch` is already provider-neutral. There is nothing SearXNG-specific to build for fetch.

**Extend the DeepSeek "Web search" card to also configure SearXNG.** Rejected: that card is credential-shaped (an API key written through the credentials domain), while SearXNG needs only a base URL. A separate, simpler card keyed on the `web-search-searxng` namespace is cleaner, and the served-namespace-gated card list ([tab-store](../../../../packages/client/ui-settings-plugins/src/client/tab-store.ts)) shows whichever provider is mounted.

**Support optional HTTP Basic auth.** Deferred: confirmed open instances only. Admitting a credential now would widen the config surface and pull the provider into the redirect/credential-leak regression contract without a current consumer.

## Consequences

Out of the box, `web_search` requires `$SEARXNG_BASE_URL` (or a configured `baseURL`) pointing at a JSON-enabled instance; without one the tool reports the capability unavailable rather than silently degrading. DeepSeek search is demoted to opt-in: its package, credential-resolution mechanism, and `web/deepseek-search-llm-request` log event remain intact and are re-selected by setting `searchProvider: deepseek-official` and mounting the row, so the [default-search note](2026-07-31-web-default-search.md)'s rationale for web_search-as-a-default, the fetch-disabled stance, and that provider's credential handling stay current for the opt-in path.

The shipped web UI shows a "Web search" card that configures the SearXNG endpoint: the card list is the intersection of registered cards and Host-served namespaces, and the provider now serves `web-search-searxng`. The shipped-default search snapshot lane drives a SearXNG JSON double that returns identical source values, so the settled search card golden is unchanged; the DeepSeek-specific auxiliary-request event assertions are dropped, and the `plugin-config` settings golden shows the SearXNG card. Package unit tests pin result/answer mapping, availability, request parameters, error/abort classification, and the settings-section projection that serves a stored endpoint to the next search; the `plugin-config` e2e edits the endpoint through the UI and asserts the write; a skippable real-instance e2e covers a live JSON-enabled instance.
