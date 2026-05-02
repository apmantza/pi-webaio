# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-05-02

### Changed

- README.md expanded with full tool parameter tables, extraction pipeline documentation, batch/Playwright/Jina usage examples
- Banner converted from SVG to PNG for broader compatibility
- CI tarball verification now checks for banner.png
- package.json `files` includes banner.png

### Removed

- SonarQube Cloud CI job and stale sonar-project.properties

## [0.1.5] - 2026-05-02

### Added

- Playwright fallback for JS-rendered pages (zero-config — uses system Chrome if installed)
- Playwright graceful degradation test
- Comprehensive README: tool parameter tables, extraction pipeline docs, batch/Playwright/Jina examples

### Changed

- `smartFetch` fallback chain: wreq-js → bot protection → Playwright Chromium
- `playwright` added to `optionalDependencies`
- `README.md` expanded from 3.7KB to 6.3KB with full parameter docs and pipeline details

## [0.1.4] - 2026-05-02

### Added

- 21 new unit tests covering search result parsers, sitemap parsing, and URL discovery (76 total)
- SonarQube Cloud integration with `sonar-project.properties`

### Changed

- Banner: removed version tag and bottom accent line

### Fixed

- GitHub Actions pinned to full commit SHAs
- SonarQube scan action bumped to v8.0.0

## [0.1.3] - 2026-05-02

### Changed

- Banner height reduced from 640px to 500px

### Fixed

- CodeQL: Closing tag regex uses `[^>]*` for robust whitespace/attribute handling
- All 11 CodeQL alerts resolved (6 fixed, 3 second-pass fixes, 2 dismissed as false positives)

## [0.1.2] - 2026-05-02

### Added

- Banner SVG for GitHub and npm package page
- `license` and `repository` fields to `package.json`

### Changed

- CI and release workflows: actions bumped to `checkout@v6` / `setup-node@v6`
- Tarball verification now checks for `banner.svg`
- README updated with banner image

### Fixed

- CodeQL: Added `data:` and `vbscript:` to URL scheme checks
- CodeQL: HTML regex now handles whitespace in closing script/style tags
- CodeQL: `frontmatter()` now escapes backslashes in titles and URLs

## [0.1.1] - 2026-04-30

### Added

- TTL cache support
- Retry logic for web requests
- Redirect detection
- HTTPS upgrade handling
- Preview truncation improvements
- Expanded test coverage
- Pi manifest, tsconfig, and type declarations

### Fixed

- `webpull` `promptSnippet` handling
- Regenerated `package-lock.json` to sync with `package.json`

### Changed

- Bump patch version to 0.1.1

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
