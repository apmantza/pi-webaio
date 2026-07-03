<!-- markdownlint-disable MD013 MD060 -->

# Contributing to pi-webaio

Thanks for helping make pi-webaio better. This project is a pi extension that gives agents reliable web access through search, fetch, mapping, crawling, extraction, storage, and RAG-friendly output.

If you use an agent, run it from the `pi-webaio` root so it picks up `AGENTS.md`. That file is durable project context and documents current architecture, tool behavior, testing commands, and release conventions.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Type-check
npm run lint

# 3. Run tests
npm run test:all

# 4. Build the published extension output
npm run build:dist
```

Pull requests should pass `npm run lint`, the relevant focused test suite, and ideally `npm run test:all`. If you edit `package.json`, run `npm install` and `npm run check:lockfile` so `package-lock.json` stays in sync.

## High-impact contribution areas

We especially want help in these areas:

- **Vertical extractors** — add API-first extractors for sites agents frequently need: docs portals, registries, forums, research sites, issue trackers, package indexes, and public data sources.
- **Search engines** — improve existing search parsing or add new engines that work without API keys and are safe to query from an agent session.
- **Known-site pipelines** — improve GitHub, GitLab, YouTube, Reddit, Stack Exchange, SonarCloud, docs-site, or package-registry handling.
- **Anti-bot resilience** — better bot-wall detection, cleaner fallback behavior, safer browser/fingerprint routing, and clearer error messages.
- **Paywall handling** — site catalog updates, marker detection, strategy ordering, and tests for opt-in bypass behavior.
- **Extraction quality** — cleaner markdown, better data-island/RSC recovery, PDF/plain-text handling, interactive-element extraction, and prompt-injection warnings.
- **Discovery and crawling** — sitemap/nav/llms.txt discovery, GitHub repo mapping, resume/checkpoint behavior, and route/adaptive selector improvements.
- **Tests and fixtures** — regression tests for tricky pages, parser fixtures, and platform-specific install/build coverage.
- **Documentation** — examples, troubleshooting, extractor authoring notes, and clearer user-facing guidance.

If you are not sure whether a site or engine belongs in core, open an issue first with the target URL, expected output, and whether a public API exists.

## Reporting issues

A good issue is short, concrete, and reproducible:

- What tool was used (`aio-webfetch`, `aio-websearch`, etc.)?
- URL/query and relevant parameters, with secrets removed
- Expected output vs. actual output
- Whether the page requires login, cookies, JavaScript, or a paywall
- pi-webaio version (`npm ls pi-webaio` or `package.json`)
- Any saved response ID, output path, or error summary

Do not paste private tokens, cookies, or paywalled/private content into public issues.

## Pull request checklist

- [ ] The diff is focused and the behavior change is clear
- [ ] New logic has tests or fixtures, especially parser/extractor logic
- [ ] `npm run lint` passes
- [ ] Relevant tests pass; run `npm run test:all` for broad changes
- [ ] `npm run build:dist` succeeds for runtime changes
- [ ] `npm run check:lockfile` passes if dependencies changed
- [ ] Docs/README/AGENTS.md are updated when behavior, commands, or invariants change
- [ ] User-facing errors are clear and do not hide the real failure mode
- [ ] Security-sensitive changes avoid leaking secrets, cookies, local paths, or private network targets

## Codebase map

| Area | Files | Notes |
|------|-------|-------|
| Extension entry | `index.ts`, `src/tools/*.ts` | Registers the six pi tools and TUI renderers. |
| Fetch pipeline | `src/content.ts`, `src/fetch.ts`, `src/tools/webfetch.ts` | URL fetch, extraction, formatting, summarization, errors. |
| Search | `src/search.ts`, `src/google-ai.ts`, `extractors/`, `bin/` | HTTP search engines plus Google CDP child processes. |
| Discovery/pull | `src/discovery.ts`, `src/tools/webmap.ts`, `src/tools/webpull.ts` | Site mapping, crawl/pull, compilation. |
| GitHub handling | `src/github-pipeline.ts`, `src/github-api.ts`, `src/github-map.ts` | GitHub URL special cases and repo mapping. |
| Vertical extractors | `src/verticals/` | API-first extractors for known sites. |
| Paywall | `src/paywall.ts`, `src/paywall-sites.ts` | Opt-in bypass detection and strategies. |
| Storage/cache | `src/session-store.ts`, `src/storage.ts` | Session cache and durable response IDs. |
| Tests | `tests/*.test.mjs` | Node test runner using native TypeScript stripping. |

## Adding a vertical extractor

Vertical extractors are the best contribution path for site-specific quality. They avoid brittle scraping by using public APIs or predictable structured endpoints.

1. Create `src/verticals/<site>.ts`.
2. Export a matcher and extractor following the existing `VerticalResult` shape in `src/verticals/types.ts`.
3. Register it in `src/verticals/registry.ts` with a specific URL pattern.
4. Return clean markdown and tag the output with a source marker such as `> via <Site>` when appropriate.
5. Preserve `ok: false` and useful error messages for network blocks, auth requirements, deleted content, or rate limits.
6. Add unit tests in `tests/unit.test.mjs` or a focused test file.
7. Document any user-facing behavior in `docs/features.md` or `docs/tools.md` if it changes the public contract.

Extractor guidelines:

- Prefer official/public APIs over HTML scraping.
- Avoid requiring API keys unless the extractor gracefully works without them.
- Do not fetch private/local URLs or follow unsafe redirects.
- Keep output deterministic and agent-readable.
- Include enough metadata for citation and follow-up fetches.

## Adding or improving a search engine

Search engines live in `src/search.ts` unless they require browser/CDP support.

1. Add a fetch URL and parser.
2. Parse title, URL, snippet, and domain.
3. Filter out the search engine's own navigation/redirect URLs.
4. Add the engine to the parallel search list and result counts.
5. Update `ENGINE_WEIGHTS` if the engine should affect ranking.
6. Add parser fixtures/tests.
7. Update `docs/features.md` and `docs/tools.md` when user-visible behavior changes.

Search engine requirements:

- No mandatory API keys.
- Respect bounded timeouts and partial success behavior.
- Fail soft: one broken engine must not break the whole search.
- Avoid storing or logging user secrets.

## Paywall and anti-bot changes

Paywall bypass is opt-in (`bypass: true`). Keep that invariant.

- Add/adjust site strategy entries in `src/paywall-sites.ts`.
- Add marker or strategy logic in `src/paywall.ts`.
- Include regression tests in `tests/paywall.test.mjs`.
- Make failures honest: if all strategies still return a paywall, report that rather than pretending success.
- Do not add behavior that silently bypasses a paywall without the explicit `bypass` flag.

For generic anti-bot handling, prefer clear detection and fallback summaries over endless retries.

## Testing commands

Focused suites:

```bash
npm test
npm run test:new
npm run test:paywall
npm run test:check
npm run test:render
npm run test:fetcherror
npm run test:fetchprogress
npm run test:hardening
npm run test:format
npm run test:webfetch-summary
npm run test:chunker
npm run test:github-map
npm run test:reddit
npm run test:integration
```

Full validation:

```bash
npm run lint
npm run check:lockfile
npm run test:all
npm run build:dist
```

## Release notes and changelog

`CHANGELOG.md` is the source of truth for GitHub release notes. Use:

```bash
npm run changelog:extract -- 0.6.1 --summary
npm run release:backfill-notes -- --repo apmantza/pi-webaio
```

When preparing a release, add a dated version section with Added/Changed/Fixed bullets before tagging/publishing.

## License

pi-webaio is MIT licensed. By contributing, you agree that your contributions will be licensed under the same terms.
