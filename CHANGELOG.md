# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-30

### Added

- Initial release of pi-webaio
- `aio-websearch` tool - Search the web using DuckDuckGo or Brave
- `aio-webfetch` tool - Fetch single/batch URLs and convert to markdown
- `aio-webcontent` tool - Retrieve cached content from session storage
- `aio-webpull` tool - Pull entire sites via sitemap/crawling
- Anti-bot TLS fingerprinting (chrome_145, firefox_147, safari_26, edge_145)
- GitHub-aware fetch (clones repos, uses API for trees/blobs)
- PDF extraction support
- RSC (Next.js) extraction
- Secret scanning in URLs
- Prompt injection detection
- Session storage for cached content
