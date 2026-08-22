# Agent Note: SearXNG as the shipped default search provider

Status: implemented

[English](2026-08-22-searxng-default-search.md) | 中文

## Problem

随产品提供的默认 `web_search` 由 `deepseek-official` 支持，它在每次搜索时都用原生服务端工具发起一次辅助 DeepSeek Messages 调用——一次完整的、计费的模型轮次，复用 `DEEPSEEK_API_KEY`（[默认搜索决策](2026-07-31-web-default-search.zh.md)）。若某部署更倾向使用自托管、由运维方掌控、且无按次搜索模型成本的元搜索引擎，则必须自行编写覆盖层，而 harness 并未随产品提供这样的提供方。[SearXNG](https://github.com/searxng/searxng) 正是这样的引擎，但它唯一的结构化 API 是 `GET /search?format=json`；它没有内容抓取 API，因此只适配搜索提供方这一角色。

## Decision

新实现包 `@deepseek-ai/dsh-web-search-searxng` 像其他搜索后端一样，向 `ctx.web` 注册一个 `searxng` `WebSearchProvider`。`dsh-base` 挂载它并设置 `web.searchProvider: searxng`，替换原 `web-search-deepseek` 配置项；同时移除 `dsh-tool-web` 的 `searchTimeoutMs: 60000` 覆盖，使提供方无关的 30 秒默认值生效，因为一次 SearXNG 搜索是单次快速的元搜索 HTTP 调用，而非辅助模型请求。不新增抓取提供方：抓取本就是提供方无关的（`web-fetch-http`），且 SearXNG 不提供抓取 API。

提供方发起 `GET {baseURL}/search?q=<query>&format=json`，并附加已配置的 `language`／`safesearch`／`time_range`／`categories`／`engines`。它将每项 `results[]` 结果映射为一个 source（`content` → `snippet`、`publishedDate` → `publishedAt`，丢弃无 URL 的条目，保留无 snippet 的条目），并将即时 `answers[]`（字符串或 `{ answer }` 对象，跨版本均可容忍）折叠进 seam 的可选 `content`。不发送 `maxResults`——SearXNG 通过 `pageno` 分页，因此最终上限由 seam 负责。`baseURL` 来自配置或 `$SEARXNG_BASE_URL`；在其指向一个可解析的 `http(s)` 实例之前提供方不可用，因此未设置基址会让被显式选中的提供方以 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 失败，与 DeepSeek 路由缺少密钥时相同的「响亮失败」形状。实例必须启用 JSON 输出（`search.formats` 包含 `json`）；仅 HTML 的实例会返回错误页，并以 `WEB_PROVIDER_ERROR` 呈现。

SearXNG 实例无需凭据即可访问，因此提供方不携带任何密钥。其接口地址与查询开关构成一个可编辑的设置分区（`web-search-searxng`），并在每次搜索时投影，因此从 web UI 更改的接口地址无需重新注册即可在下一次搜索生效；`@deepseek-ai/dsh-client-ui-settings-plugins` 随附一张网页搜索卡，可编辑接口地址（`baseURL`）以及 `language`、`safeSearch`、`engines` 等开关。请求设置 `redirect: 'error'`，与带凭据的提供方保持一致。

## Alternatives considered

**保留 DeepSeek 为默认，仅将 SearXNG 作为可选项提供。** 否决：需求是让 SearXNG 成为默认；在现有三个提供方旁再加一个可选项并不会改变随产品提供的体验。

**同时挂载两个提供方并选中 `searxng`。** 否决：seam 会正确解析（显式 id 优先），但随产品提供的 web UI 中、按服务 namespace 门控的「网页搜索」设置卡是 DeepSeek 形状的（在 `web-search-deepseek` namespace 上的一个 API 密钥）。保留它挂载会在 SearXNG 实为默认时呈现一个 DeepSeek 密钥表单——一个具误导性的配置界面。完全替换让随产品状态更诚实；DeepSeek 搜索仍只差一行配置即可恢复。

**也构建一个 SearXNG 抓取提供方。** 否决：SearXNG 没有内容抓取 API，且 `web_fetch` 本就是提供方无关的。抓取没有任何 SearXNG 专属内容可构建。

**扩展 DeepSeek「网页搜索」卡以同时配置 SearXNG。** 否决：该卡是凭据形状的（通过凭据域写入的 API 密钥），而 SearXNG 只需要一个基址。以 `web-search-searxng` namespace 为键的、更简单的独立卡更清晰，并且按服务 namespace 门控的卡片列表（[tab-store](../../../../packages/client/ui-settings-plugins/src/client/tab-store.ts)）会显示当前挂载的那个提供方对应的卡。

**支持可选的 HTTP Basic 认证。** 暂缓：已确认仅面向开放实例。此刻引入凭据会扩大配置界面，并在没有当前消费方的情况下把提供方拉入重定向／凭据泄漏的回归约束。

## Consequences

开箱即用时，`web_search` 需要 `$SEARXNG_BASE_URL`（或配置的 `baseURL`）指向一个启用 JSON 的实例；没有它，工具会报告该能力不可用，而非静默降级。DeepSeek 搜索被降级为可选：其包、凭据解析机制以及 `web/deepseek-search-llm-request` 日志事件均保持完好，通过设置 `searchProvider: deepseek-official` 并挂载该配置项即可重新选用，因此[默认搜索 note](2026-07-31-web-default-search.zh.md) 中关于 web_search 作为默认、禁用抓取的立场，以及该提供方的凭据处理，对可选路径而言仍然有效。

随产品提供的 web UI 显示一张配置 SearXNG 接口地址的「网页搜索」卡：卡片列表是已注册卡片与 Host 已服务 namespace 的交集，而提供方现在服务 `web-search-searxng`。随产品默认搜索的快照通道驱动一个返回相同 source 值的 SearXNG JSON double，因此已落定的搜索卡 golden 保持不变；DeepSeek 专属的辅助请求事件断言被移除，`plugin-config` 设置 golden 显示该 SearXNG 卡。包单元测试固定结果／答案映射、可用性、请求参数、错误／中止分类，以及把已存储接口地址交付给下一次搜索的设置分区投影；`plugin-config` e2e 通过 UI 编辑接口地址并断言写入；一个可跳过的真实实例 e2e 覆盖一个启用 JSON 的真实实例。
