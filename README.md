<!-- markdownlint-disable MD041 -->

![pi-webaio](banner.png)

# pi-webaio

All-in-one web access tools for [pi](https://pi.dev): search, fetch, crawl,
extract, map, cache, chunk, and render web content for AI agents.

## What It Does

pi-webaio registers seven pi tools:

- `aio-websearch` — search DuckDuckGo, Brave, Yahoo, Bing, and Google in parallel
- `aio-webfetch` — fetch one or many URLs into markdown or structured formats
- `aio-webcontent` — retrieve cached content by URL
- `aio-webresult` — retrieve cached results by response ID
- `aio-webmap` — discover site pages or map GitHub repositories without fetching
- `aio-webpull` — crawl/pull sites into local markdown files
- `aio-webquery` — BM25 search over a locally-pulled corpus (offline, no re-fetching)

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
- [Custom vertical extractors](docs/custom-verticals.md) — add your own site
  extractors (company wikis, niche sites) without forking
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
