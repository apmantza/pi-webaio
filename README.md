<!-- markdownlint-disable MD041 -->

![pi-webaio](banner.png)

# pi-webaio

All-in-one web access tools for [pi](https://pi.dev): search, fetch, crawl,
extract, map, cache, chunk, and render web content for AI agents.

## What It Does

pi-webaio registers eight pi tools:

- `aio-websearch` — search DuckDuckGo, Brave, Yahoo, Bing, **TinyFish**, and **FireCrawl** in parallel, with default Google (via a local CDP broker) and an opt-in Reddit CDP companion (`reddit: true`, requires Chrome). Returns in ~2.9s with live per-provider TUI progress (spinner rows, result counts with latency, an elapsed-vs-target bar) and a stable final view showing every engine's count and timing
- `aio-webfetch` — fetch one or many URLs into markdown or structured formats, with an opt-in heading outline, query-focused answer mode, and multi-source cited answers
- `aio-webcontent` — retrieve cached content by URL (with opt-in section-level diff)
- `aio-webresult` — retrieve cached results by response ID
- `aio-webmap` — discover site pages or map GitHub repositories without fetching
- `aio-webpull` — crawl/pull sites into local markdown files
- `aio-webquery` — BM25 search over a locally-pulled corpus (offline, no re-fetching)
- `aio-webresearch` — single-round research bundle: search → rank → fetch → cited evidence bundle on disk

It includes anti-bot TLS fingerprinting, browser fallback, 21 API-first
extractors (GitHub, YouTube, npm/PyPI and other package registries, Context7,
DeepWiki, and more), RAG chunking, TUI progress rendering, phase-aware errors,
opt-in paywall bypass support, and **keyless providers** (FireCrawl) that work
without API keys.

### Extra Providers

**FireCrawl Keyless** (free, 1k credits/month, **no API key needed**):

- Search: works out of the box as a search provider
- Fetch: `firecrawl: true` on `aio-webfetch` — delegates to FireCrawl Scrape API

**TinyFish** (free, requires API key in `~/.piwebaio/config` or `~/.piwebaio/.env`):

- Search: unlimited free search results
- Fetch: `tinyfish: true` on `aio-webfetch` — delegates to TinyFish Fetch API

Both providers run in parallel with the HTTP engines during search.
For fetch, the recommended chain is FireCrawl → TinyFish → normal pipeline.

Google Search uses the local CDP broker by default (faster cold start, tighter
p95, 100% Google success under concurrency — see `speed.md`). Google ignores the
deprecated `num` param and renders ~8–10 organic results per SERP page, so the
broker **paginates through `?start=10`, `?start=20`, …** (the same mechanism
Google's own "Next" links use), merging and URL-deduping pages up to `max` until
the lane is satisfied, the SERP runs out of new organics, or the lane budget is
exhausted. The Google lane carries a hard 3-second cap measured from when its
search starts, so it never gates the tool's 7-second overall deadline — even on
a full multi-page pagination. If a page-2+ navigation or extraction fails, the
lane degrades gracefully to the results it had already collected and annotates
`googleStatus` accordingly (e.g. `ok (an extra SERP page failed…)`); a total
fresh failure still surfaces as an error. Set `PI_WEBAIO_CDP_BROKER=0` to force
the legacy extractor.
The manual, live-only benchmark is `npm run bench:google-cdp -- --live
--query "..." --samples 3`. It reports total/startup measurements; detailed CDP
phase timings are not yet instrumented, and no speedup is inferred.

For the **full public tool path** (HTTP engines + Google + Reddit under the
response target), use `scripts/bench-full-search.mjs`:

```bash
node --experimental-strip-types scripts/bench-full-search.mjs broker 10 3000 "query"
```

`<legacy|broker>` picks the Google path; sample 1 measures cold start and
samples 2–n are warm; the third argument is inter-sample spacing in ms. On the
2.9s response-target path the tool returns at the budget by design — recent
runs: p50 ≈ 2.90s both modes, HTTP success 10/10 (see `speed.md` for full
tables and environment caveats).

## Install

```bash
pi install npm:pi-webaio
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-webaio
```

## Static Fetch API

Use `pi-webaio/webfetch` when an integration needs local extraction without
registering the eight `aio-*` tools:

```js
import { fetch } from "pi-webaio/webfetch";

const abortController = new AbortController();
const result = await fetch("https://example.com/article", {
  format: "markdown",
  maxChars: 50_000,
  signal: abortController.signal,
});

if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
console.log(result.content);
```

The entrypoint uses `wreq-js` TLS fingerprinting and local Defuddle extraction.
It does not start a browser, call a remote reader, register pi tools, or write a
content cache. HTTP and literal client-side redirects are followed manually.
For direct requests, each destination is checked by the public-network guard
and pinned into the `wreq-js` transport before connection. Cross-origin
redirects retain only `Accept`, `Accept-Language`, and `User-Agent` from the
request headers.

The default call budget is 15 seconds, including bounded cleanup. The call can
download up to 10 MiB across all retry attempts and redirect responses, then
return up to 50,000 characters. It follows at most ten redirects and retries a
failed hop at most twice. The input cap cannot exceed 10 MiB.

Header names and values are validated before a request. Transport-controlled
framing headers such as `Host` and `Content-Length` are rejected.

`format` accepts `markdown`, `html`, `text`, `json`, or `raw`. `html` requires
an HTML response and returns Defuddle's cleaned HTML. `json` requires a JSON
response and returns pretty-printed JSON text. `text` removes markup from HTML
and XML. `raw` returns the decoded textual response before extraction; binary
responses are rejected. HTML extraction accepts `removeImages` and
`includeReplies`.

A configured proxy is checked and pinned before connection. HTTP(S) forward
proxies and `socks5h` proxies can resolve the target independently, so target
pinning cannot be enforced through those modes. Use them only with a proxy
whose destination policy you trust. Successful results report
`targetPinning: "proxy-dependent"` when a proxy is configured.

## Documentation

- [Features](docs/features.md) — overview, extraction pipeline, GitHub/YouTube
  handling, output formats, chunking, errors, and search ranking
- [Custom vertical extractors](docs/custom-verticals.md) — add your own site
  extractors (company wikis, niche sites) without forking
- [Usage guide](docs/usage.md) — common pi prompts and examples
- [Tools reference](docs/tools.md) — tool names, parameters, and defaults
- [Architecture](docs/architecture.md) — build, TUI rendering, FetchError system,
  CI, and security notes
- [MCP server](docs/mcp.md) — use the tools from Claude Code, Claude Desktop,
  and other MCP clients without pi (`npx -y pi-webaio-mcp`)
- [PageMap inspiration](docs/pagemap-inspiration.md) — future extraction and
  structured-output ideas

## Contributing

We especially welcome contributors for new vertical extractors, search engines,
site-specific fetch fixes, anti-bot/paywall resilience, and docs. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, testing, and contribution
checklists.

## Contributors

Thanks goes to these wonderful people:

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
<tbody>
<tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/apmantza"><img src="https://avatars.githubusercontent.com/u/247365598?v=4" width="100px;" alt=""/><br /><sub><b>Apostolos Mantzaris</b></sub></a><br /><a href="#code-apmantza" title="Code">💻</a> <a href="#doc-apmantza" title="Documentation">📖</a> <a href="#ideas-apmantza" title="Ideas & Planning">🤔</a> <a href="#maintenance-apmantza" title="Maintenance">🚧</a> <a href="#review-apmantza" title="Reviewed Pull Requests">👀</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/ptbsare"><img src="https://avatars.githubusercontent.com/u/3147576?v=4" width="100px;" alt=""/><br /><sub><b>ptbsare</b></sub></a><br /><a href="#code-ptbsare" title="Code">💻</a> <a href="#bug-ptbsare" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/jacksenechal"><img src="https://avatars.githubusercontent.com/u/87883?v=4" width="100px;" alt=""/><br /><sub><b>Jack Senechal</b></sub></a><br /><a href="#code-jacksenechal" title="Code">💻</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/apps/dependabot"><img src="https://avatars.githubusercontent.com/in/29110?v=4" width="100px;" alt=""/><br /><sub><b>Dependabot</b></sub></a><br /><a href="#maintenance-dependabot[bot]" title="Maintenance">🚧</a></td>
    </tr>
</tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

If you land a pull request or report an issue that gets fixed, we'll add you here.

## License

pi-webaio is released under the [MIT License](LICENSE).
