<!-- markdownlint-disable MD013 MD024 MD060 -->

# PageMap Inspiration — Future Ideas for pi-webaio

Source: [Retio-ai/Retio-pagemap](https://github.com/Retio-ai/Retio-pagemap) — AGPL-3.0
Analyzed: 2026-05-08

---

## Already Implemented (v0.3.1+)

- [x] HTML attribute stripping (`src/html-compress.ts`) — strips class, id, data-\*, style, event handlers before extraction
- [x] Token estimation (`src/token-count.ts`) — approximate GPT token counting with CJK support
- [x] Interactive element extraction (`src/interactive-elements.ts`) — buttons, links, forms as `[1] button: Buy (click)` refs
- [x] Token-budget markdown pruning (`src/prune-markdown.ts`) — score-based section pruning
- [x] `prune` and `interactive` params on `aio-webfetch`

---

## Medium Effort — Page Classification

### Page Type Classifier (`src/page-classifier.ts`)

PageMap auto-detects 16 page types and applies optimized extraction per type. We could do the same:

```
product_detail | listing | search_results | article | news | video
login | form | checkout | dashboard | help_faq | settings
error | documentation | landing | blocked
```

**Approach:**

- Parse `<meta>`, JSON-LD, OpenGraph tags
- DOM structure heuristics (e.g., `<main>` + product schema = product_detail)
- URL pattern matching (`/products/`, `/docs/`, `/search?q=`)
- Fallback to generic

**Benefit:** Enables type-specific extractors (price from product pages, author/date from articles, etc.)

### Type-Specific Extractors (`src/extractors/`)

Once we know the page type, extract structured data:

| Type           | Extract                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| product_detail | name, price, currency, rating, review_count, brand, options (size/color), availability, images |
| article        | headline, author, date_published, body, publisher                                              |
| listing        | cards (name, price, thumbnail), pagination, filters                                            |
| search_results | query, total_results, cards                                                                    |
| faq            | questions, answers                                                                             |
| event          | name, date, location, price                                                                    |
| login          | form fields, OAuth providers                                                                   |

**Key technique from PageMap:** Use `itemprop` attributes (`itemprop="price"`, `itemprop="name"`, etc.) and JSON-LD schemas as primary signals, DOM heuristics as fallback.

---

## Medium Effort — i18n Keyword Matching

### Multi-Language Schema Field Detection

PageMap's `pruner.py` has extensive i18n regex dictionaries for 10 languages detecting:

- **Price terms** (price, 가격, 価格, prix, Preis, precio, prezzo, preço, prijs)
- **Rating terms** (rating, 평점, 評価, note, Bewertung, puntuación, valutazione, avaliação, beoordeling)
- **Brand terms** (brand, 브랜드, ブランド, marque, Marke, marca, marchio, marca, merk)
- **Shipping terms** (shipping, 배송, 配送, livraison, Versand, envío, spedizione, envio, verzending)
- **Availability** (in stock, 재고, 在庫, en stock, auf Lager, disponible, disponibile, disponível, op voorraad)
- **Discount terms** (sale, 할인, 割引, solde, Angebot, oferta, sconto, promo, korting)

**Approach:** Build a TypeScript version of the i18n term dictionaries from PageMap's `i18n_patterns.py` and `i18n.py`. Use them for:

- Pruning relevance scoring (price/rating sections get higher keep scores)
- Structured data extraction (find price even without schema markup)
- Page type classification (e.g., price + rating + options → product page)

---

## Medium Effort — DOM-Based Pruning

### Chunk-Based HTML Pruning (PageMap approach)

Current `prune-markdown.ts` works on already-converted markdown. PageMap prunes at the HTML level, which is more accurate:

1. **Chunk the HTML** into typed chunks: META, HEADING, TEXT_BLOCK, TABLE, LIST, FORM, MEDIA, RSC_DATA
2. **Score each chunk** by relevance to the detected page type
3. **Adjacent boost** — keep chunks neighboring SCHEMA_MATCH chunks for context
4. **Budget-based drop** — drop lowest-score chunks until token budget is met
5. **Re-merge** selected HTML → run through defuddle

**Key files to study:**

- `src/pagemap/core/pruning/pruner.py` — the full rule-based pruner (~500 lines)
- `src/pagemap/core/pruning/preprocessor.py` — sibling grouping + block tree
- `src/pagemap/core/pruning/compressor.py` — re-merge + lossless HTML compression

**Benefit:** Much smarter pruning than markdown-level. Can keep "price" section even if it's a `<table>`, drop nav even if it has headings, etc.

### Block Tree & Sibling Grouping

PageMap's preprocessor groups adjacent siblings (e.g., `<p>` + `<p>` + `<p>` in the same parent) into a single TEXT_BLOCK chunk. This prevents heading-based section splitting from fragmenting paragraphs.

---

## Medium Effort — Output Format Upgrades

### Structured Agent Prompt Format

PageMap's serializer produces a clean YAML-ish format:

```yaml
URL: example.com/product/123
Title: Product Name
Type: product_detail

## Ecommerce
Name: Overfit Leather Jacket
Price: 189,000원 (was 259,000원)
Rating: 4.6/5 (847 reviews)

## Actions
[1] button: 장바구니 담기 (click)
[2] select: 사이즈 선택 (select) options=[S,M,L,XL]

## Info
<pruned HTML content>

## Images
  [1] https://cdn.example.com/product.jpg

## Meta
Tokens: ~1,800 | Interactables: 24 | Generation: 380ms
```

We could add a `format: "pagemap"` option to `aio-webfetch` that produces this structured output instead of raw markdown.

### Diff Output for Cache Refreshes

PageMap supports cache-diff output — when re-fetching a cached page, only changed sections are re-sent:

```
PageMap Update
Status: updated | refs expired
Changes:
- Actions: 3 new items (27 total)
- Ecommerce: updated

## Actions (27 total)
[1] ... (full action list)

## Ecommerce (updated)
Price: $54.99 (was $49.99)

## Info — unchanged
## Images — unchanged
```

Useful for monitoring pages that change frequently (prices, stock).

---

## Medium Effort — Smart Recovery & Diagnostics

### Barrier Detection

PageMap detects page-level obstacles and tells the agent what to do:

```yaml
State:
  barrier: login_required
  barrier_hint: "Login form detected. Use fill_form to authenticate."
```

Barrier types: `cookie_consent`, `login_required`, `bot_blocked`, `out_of_stock`, `empty_results`, `error_page`, `age_verification`, `region_restricted`, `popup_overlay`

We could add a `barrier` field to PullResult that detects these from the fetched content.

### Stale Ref Recovery

When DOM mutations invalidate interactable refs, PageMap detects this and returns guidance to re-fetch — rather than silently failing.

### Bot Detection Awareness

PageMap detects Cloudflare, Turnstile, reCAPTCHA, hCaptcha, Akamai. We already have `src/bot-detection.ts` for this — could enhance it with provider-specific retry strategies.

---

## Higher Effort — Big Bets

### E-Commerce Deep Coverage

PageMap has built-in support for 30+ e-commerce sites across 4 tiers with site-specific extraction configs:

- **Global:** Amazon, eBay, AliExpress, SHEIN, Walmart, Rakuten
- **Fashion:** Zara, H&M, Nike, Uniqlo, ASOS, Zalando, SSENSE, Farfetch, COS
- **Korea:** Coupang, Naver Shopping, Musinsa, 29CM, W Concept, SSG, 11st
- **Japan/China:** ZOZO, Tmall, JD.com, Taobao

Each has custom selectors for name, price, options, cart button, etc. plus cookie consent auto-dismiss patterns.

**Approach:** Extend `src/verticals/` with e-commerce site configs. Use the existing vertical extractor registry pattern.

### Browser-Side JS Security Scanner

PageMap injects a JS bundle into the browser page that scans for:

- Hidden text (prompt injection attempts in the DOM)
- Iframe threats
- Shadow DOM manipulation
- Layout-based deception

Results cross-validated with server-side content scanner. We already have `detectPromptInjection()` — could add DOM-level scanning.

### Template Caching

PageMap caches page templates (DOM structure fingerprints) to skip re-extraction for same-template pages. First page on a site takes ~1.5s, subsequent pages on same template take ~10ms.

---

## Not Worth Porting

- **MCP server architecture** — PageMap is an MCP server; pi-webaio is a pi extension. Different integration model.
- **E-commerce flow state machine** — Cart flows, checkout state machines. Too domain-specific.
- **Browser dependency (Playwright)** — pi-webaio's strength is lightweight HTTP fetching with wreq-js. Keep it.
- **Python** — Port logic to TypeScript, not the language.

---

## Recommended Priority Order

1. **Page type classifier** — unlocks everything else, relatively low effort
2. **i18n keyword dictionaries** — reusable across pruning, extraction, classification
3. **Chunk-based HTML pruning** — the biggest quality improvement for pruned output
4. **Type-specific extractors** — structured data from any page, no site-specific config
5. **Structured output format** — `format: "pagemap"` option
6. **Barrier detection** — immediately useful for agent error handling
