# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

由 [SearXNG](https://github.com/searxng/searxng) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它调用自托管 SearXNG 实例的 `GET /search?format=json` 端点，把扁平 `results[]` 映射为 seam 规范化的 `WebSearchResult`，并将即时 `answers[]` 折叠进 `content`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

SearXNG 是 [`dsh-base`](../../bundle/base/README.zh.md) 随产品提供的默认搜索提供方；当 `SEARXNG_BASE_URL`（或配置的 `baseURL`）指向一个已启用 JSON 输出的实例时即可使用。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL` | SearXNG 实例基址；追加 `/search`。缺失、无法解析或非 `http(s)` 时提供方不可用。 |
| `language` | （实例默认） | 以 `language` 发送的界面／引擎语言（例如 `en`、`all`）。 |
| `safeSearch` | （实例默认） | 以 `safesearch` 发送的安全搜索级别：`0` 关闭、`1` 适中、`2` 严格。 |
| `timeRange` | （未设置） | 以 `time_range` 发送的时间范围：`day`、`week`、`month` 或 `year`。未设置时不发送过滤条件。 |
| `categories` | （实例默认） | 以 `categories` 发送的逗号分隔类别列表（例如 `general,news`）。 |
| `engines` | （实例默认） | 以 `engines` 发送的逗号分隔引擎列表（例如 `google,bing`）。 |

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: !!js process.env.SEARXNG_BASE_URL
```

> 实例**必须启用 JSON 输出**（其 `settings.yml` 的 `search.formats` 需包含 `json`）。默认安装通常仅提供 HTML；此时 JSON 请求会返回 HTML 错误页，并以 `WEB_PROVIDER_ERROR` 呈现。

当存在 settings 服务时，这些字段构成一个可编辑的设置分区（`web-search-searxng`），web 应用还随附一张**网页搜索**卡（`@deepseek-ai/dsh-client-ui-settings-plugins`），可编辑接口地址（`baseURL`）以及 `language`、`safeSearch`、`engines` 等开关。提供方在每次搜索时投影已解析的分区，因此从 UI 更改的值无需重启即可在下一次搜索生效。

## 映射

提供方发起 `GET {baseURL}/search?q=<query>&format=json`，并在配置时附加 `language`／`safesearch`／`time_range`／`categories`／`engines`。每项 `results[]` 结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `content`、`publishedAt` ← `publishedDate`。没有 URL 的条目会被丢弃；没有 snippet 的条目会保留（URL 和标题仍有用）。即时 `answers[]`（纯字符串或 `{ answer }` 对象，跨 SearXNG 版本均可容忍）会被合并进结果的 `content`。SearXNG 没有结果数量参数（它通过 `pageno` 分页），因此不发送 `maxResults`，最终上限由 seam 强制执行。提供方失败（HTTP 错误、网络失败、响应体无法解析或结构不符）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、snippet 与发布日期，以及作为搜索答案的即时答案文本，或将确切的错误消息 `SearXNG search aborted`、`SearXNG search request failed: <error>` 和 `SearXNG returned an unprocessable response body: <error>` 置于消费方的错误包装层内。提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **实例必须启用 JSON 输出**：若实例 `search.formats` 未包含 `json`，请求会以 `WEB_PROVIDER_ERROR` 失败；提供方无法远程启用它。
- **仅单页**：SearXNG 通过 `pageno` 分页；本提供方只抓取一页，因此返回结果可能少于请求数量。多页累积等待明确需求。
- **仅支持开放实例**：位于 HTTP Basic 认证、令牌或反爬墙之后的实例不受支持；凭据处理等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
