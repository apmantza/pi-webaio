<!-- markdownlint-disable MD041 -->

![pi-webaio](banner.png)

# pi-webaio

All-in-one web access tools for [pi](https://pi.dev): search, fetch, crawl,
extract, map, cache, chunk, and render web content for AI agents.

## What It Does

pi-webaio registers six pi tools:

- `aio-websearch` — search DuckDuckGo, Brave, Yahoo, Bing, and Google in parallel
- `aio-webfetch` — fetch one or many URLs into markdown or structured formats
- `aio-webcontent` — retrieve cached content by URL
- `aio-webresult` — retrieve cached results by response ID
- `aio-webmap` — discover site pages or map GitHub repositories without fetching
- `aio-webpull` — crawl/pull sites into local markdown files

It includes anti-bot TLS fingerprinting, browser fallback, GitHub/YouTube/package
registry extractors, RAG chunking, TUI progress rendering, phase-aware errors,
and opt-in paywall bypass support.

## Install

```bash
pi install npm:pi-webaio
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-webaio
```

## Documentation

- [Features](docs/features.md) — overview, extraction pipeline, GitHub/YouTube
  handling, output formats, chunking, errors, and search ranking
- [Usage guide](docs/usage.md) — common pi prompts and examples
- [Tools reference](docs/tools.md) — tool names, parameters, and defaults
- [Architecture](docs/architecture.md) — build, TUI rendering, FetchError system,
  CI, and security notes
- [PageMap inspiration](docs/pagemap-inspiration.md) — future extraction and
  structured-output ideas

## Contributing

We especially welcome contributors for new vertical extractors, search engines,
site-specific fetch fixes, anti-bot/paywall resilience, and docs. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, testing, and contribution
checklists.

## License

MIT
