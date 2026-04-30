# pi-webaio

All-in-one web access tools for [pi](https://pi.dev) with search, fetch, crawl, extraction, and anti-bot TLS fingerprinting.

## Installation

```bash
pi install npm:pi-webaio
```

Or from git:

```bash
pi install git:github.com/apmantza/pi-webaio
```

## Tools

| Tool             | Description                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aio-websearch`  | Search the web using DuckDuckGo or Brave (no API key required). Returns compact results with title, URL, and snippet.                                        |
| `aio-webfetch`   | Fetch a single URL (or batch of URLs) and convert to markdown with anti-bot TLS fingerprinting. Detects PDFs, GitHub repos, and Next.js RSC.                 |
| `aio-webcontent` | Retrieve previously fetched content from session storage by URL.                                                                                             |
| `aio-webpull`    | Pull any public website or docs site into local markdown files with anti-bot TLS fingerprinting. Discovers pages via sitemap, navigation links, or crawling. |

## Features

- **Anti-bot TLS fingerprinting** - Uses `wreq-js` with browser profiles (chrome_145, firefox_147, safari_26, edge_145)
- **GitHub-aware fetch** - Detects repos, trees, blobs; clones repos or uses API
- **PDF extraction** - Extracts text from PDFs
- **RSC extraction** - Extracts Next.js React Server Components
- **Mozilla Readability** - Article extraction
- **Defuddle** - HTML-to-markdown conversion
- **Secret scanning** - Blocks requests containing API keys/tokens in URLs
- **Prompt injection detection** - Warns/redacts/tags suspicious content
- **Session caching** - Stores fetched content for quick retrieval

## Usage Examples

### Search the web

```
Use aio-websearch to find the latest React documentation
```

### Fetch a URL

```
Use aio-webfetch to download https://example.com/article
```

### Pull an entire site

```
Use aio-webpull to download https://docs.example.com (max: 50 pages)
```

## License

MIT
