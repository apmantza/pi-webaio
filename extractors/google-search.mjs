#!/usr/bin/env node

// extractors/google-search.mjs
// Navigate google.com, type query into search box, submit, wait for results,
// return clean list of results (title, url, snippet).
//
// Usage:
//   node extractors/google-search.mjs "<query>" [--tab <prefix>] [--max <n>]
//
// Output (stdout): JSON { query, url, results: [{ title, url, snippet }] }
// Errors go to stderr only — stdout is always clean JSON for piping.

import { pathToFileURL } from "node:url";
import {
	cdp,
	closeTarget,
	getOrOpenTab,
	handleError,
	outputJson,
	parseArgs,
	prepareArgs,
	validateQuery,
} from "./common.mjs";
import { dismissConsent } from "./consent.mjs";

// ─── Legacy phase timing instrumentation ────────────────────────────
// Opt-in via PI_WEBAIO_LEGACY_TIMINGS=1 or PI_WEBAIO_DEBUG=1. Timing output
// is written to stderr so the extractor's stdout JSON contract remains unchanged.
const LEGACY_TIMINGS_ENABLED =
	process.env.PI_WEBAIO_LEGACY_TIMINGS === "1" ||
	process.env.PI_WEBAIO_DEBUG === "1";
const phaseTimings = {};
let phaseStartedAt = Date.now();
const searchStartedAt = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// JSON.stringify is not sufficient when a value is interpolated into code
// passed to Runtime.evaluate: line separators and HTML-significant characters
// should remain escaped in the generated JavaScript source.
export function jsEvalLiteral(value) {
	return JSON.stringify(value).replace(
		/[<>\u2028\u2029]/g,
		(character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** Close the current phase stopwatch and attribute it to `name`. */
export function markPhase(name) {
	const now = Date.now();
	phaseTimings[name] = (phaseTimings[name] || 0) + (now - phaseStartedAt);
	phaseStartedAt = now;
}

/** Emit collected phase timings to stderr (no-op unless env-gated on). */
export function emitPhaseTimings(extra = {}) {
	if (!LEGACY_TIMINGS_ENABLED) return;
	process.stderr.write(
		`PI_WEBAIO_LEGACY_TIMINGS ${JSON.stringify({
			phases: phaseTimings,
			...extra,
		})}\n`,
	);
}

/**
 * Poll an asynchronous condition until it returns a truthy value or expires.
 * The first probe is immediate; callers can inject sleep for deterministic tests.
 */
export async function waitForCondition(
	probe,
	{
		timeoutMs = 15000,
		intervalMs = 100,
		sleepFn = sleep,
		nowFn = Date.now,
	} = {},
) {
	const deadline = nowFn() + timeoutMs;
	while (nowFn() < deadline) {
		const remainingBeforeProbe = deadline - nowFn();
		const value = await probe(Math.max(1, remainingBeforeProbe));
		if (value) return value;
		const remaining = deadline - nowFn();
		if (remaining <= 0) break;
		await sleepFn(Math.min(intervalMs, remaining));
	}
	return null;
}

// ─── Locale-agnostic selectors ──────────────────────────────────────

// Search box: textarea[name="q"] works across all Google locales
const SEARCH_BOX = 'textarea[name="q"], input[name="q"]';
// Submit: form button or keyboard Enter (we'll use Enter which is universal)

// ─── Type into search box (locale-agnostic) ─────────────────────────

async function typeIntoSearchBox(tab, text) {
	await cdp([
		"eval",
		tab,
		`
    (function(t) {
      var el = document.querySelector('${SEARCH_BOX.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');
      if (!el) return false;
      el.focus();
      el.value = '';
      document.execCommand('insertText', false, t);
      return true;
    })(${jsEvalLiteral(text)})
  `,
	]);
}

const GOOGLE_REGIONAL_HOST_RE =
	/^(?:www\.)?google\.(?:[a-z]{2,3}|[a-z]{2,3}\.[a-z]{2})$/;

function isGoogleHost(hostname) {
	return (
		hostname === "google.com" ||
		hostname.endsWith(".google.com") ||
		GOOGLE_REGIONAL_HOST_RE.test(hostname)
	);
}

export function isGoogleSearchUrl(rawUrl, query) {
	try {
		const url = new URL(rawUrl);
		const hostname = url.hostname.toLowerCase();
		const googleHost = isGoogleHost(hostname);
		return (
			url.protocol === "https:" &&
			googleHost &&
			url.pathname === "/search" &&
			url.searchParams.get("q") === query
		);
	} catch {
		return false;
	}
}

// ─── Submit search (press Enter — locale agnostic) ──────────────────

export async function submitSearch(tab, cdpFn = cdp) {
	// Press Enter key on the search box. The returned promise includes the
	// delayed native submit so form/rerender failures reject through CDP.
	await cdpFn([
		"eval",
		tab,
		`
    (function() {
      var el = document.querySelector('${SEARCH_BOX.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');
      if (!el) {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.name === 'q') el = active;
      }
      if (!el) throw new Error('Google search form is unavailable');
      var form = el.closest('form');
      if (!form) throw new Error('Google search form is unavailable');
      el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true}));
      // Do not await across navigation: Chrome destroys this execution
      // context as soon as submit begins. The caller verifies the resulting
      // Google search URL before accepting results.
      setTimeout(function() {
        try { HTMLFormElement.prototype.submit.call(form); } catch (_) {}
      }, 100);
      return true;
    })()
  `,
	]);
}

// ─── Extract results ────────────────────────────────────────────────

async function extractResults(tab, maxResults = 10) {
	const raw = await cdp([
		"eval",
		tab,
		String.raw`
    (function() {
      var results = [];
      // Strategy: find all h3 headings inside links, then find their container for snippet
      var headings = document.querySelectorAll('a[href^="http"] h3');
      var seen = new Set();
      
      for (var i = 0; i < headings.length && results.length < ${maxResults}; i++) {
        var h3 = headings[i];
        var a = h3.closest('a');
        if (!a) continue;
        
        var url = a.href;
        // Skip google.com internal links (check hostname not raw substring)
        try { var u2 = new URL(url); var isGoogleHost = u2.hostname === 'google.com' || u2.hostname.endsWith('.google.com'); if (isGoogleHost && !u2.pathname.startsWith('/search')) continue; } catch(e) {}
        if (seen.has(url)) continue;
        seen.add(url);
        
        var title = h3.innerText.trim();
        if (!title) continue;
        
        // Find the containing block for the snippet
        var container = a.closest('.g, [data-sokoban-container], .MjjYud, div:has(> a > h3)');
        if (!container) container = a.parentElement;
        
        // Try multiple snippet selectors
        var snippet = '';
        var snippetEl = container.querySelector('.VwiC3b, [data-sncf], span.aCOpRe, .lEBKkf, div[style*="-webkit-line-clamp"]');
        if (!snippetEl) {
          // Fallback: find the largest text block that's not the title
          var textNodes = Array.from(container.querySelectorAll('span, div'))
            .filter(function(el) { 
              var t = el.innerText?.trim();
              return t && t.length > 30 && t !== title && !el.querySelector('h3');
            })
            .sort(function(a,b) { return b.innerText.length - a.innerText.length; });
          if (textNodes[0]) snippetEl = textNodes[0];
        }
        snippet = snippetEl ? snippetEl.innerText.trim().slice(0, 300) : '';
        
        results.push({ title: title, url: url, snippet: snippet });
      }
      
      return JSON.stringify(results);
    })()
  `,
	]);

	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

// ─── Wait for search results to load ───────────────────────────────

// Google's classic SERP paginates in strides of 10 via ?start=. Each extra
// page costs a navigation + wait + extraction round, so a second page is only
// attempted when at least this much of the caller's deadline remains.
const GOOGLE_PAGE_STRIDE = 10;
const GOOGLE_PAGE_BUDGET_FLOOR_MS = 2000;
// Per-page wait ceiling: a sparse last SERP page must not stall the whole
// search waiting for the >=3-result gate inside waitForResults.
const GOOGLE_PAGE_WAIT_MS = 2500;

// Fetch page 1 (already navigated by the caller), then paginate through
// ?start=10, ?start=20, … while more results are needed and the search
// deadline still has room. Pages are merged with URL dedup; a page that
// yields zero new organics stops the loop (SERP exhausted). Bounded:
// respects the process-level deadline by never starting a page with less
// than GOOGLE_PAGE_BUDGET_FLOOR_MS remaining.
//
// Failure semantics (parity with the broker): a page-1 failure propagates
// (genuine total failure). A page-2+ failure — navigation error, or an
// extraction error on an empty/blank tail page — degrades to the merged
// set collected so far rather than discarding page-1 results.
async function extractPaginatedResults(tab, query, maxResults) {
	const merged = await extractResults(tab, maxResults);
	const seen = new Set(merged.map((r) => r.url));
	let start = GOOGLE_PAGE_STRIDE;
	while (merged.length < maxResults) {
		const deadlineAt =
			(process.env.GREEDY_SEARCH_DEADLINE_AT &&
				Number(process.env.GREEDY_SEARCH_DEADLINE_AT)) ||
			searchStartedAt + 45000;
		// Never start a page we cannot finish within the caller's deadline.
		if (deadlineAt - Date.now() < GOOGLE_PAGE_BUDGET_FLOOR_MS) break;
		const pageUrl = `https://www.google.com/search?q=${encodeURIComponent(
			query,
		)}&num=${maxResults}&start=${start}`;
		let pageResults;
		try {
			await cdp(["nav", tab, pageUrl], 15000);
			// Give the page a bounded chance to render; a page with fewer than
			// 3 organics (last SERP page) must not stall the whole search.
			await waitForResults(tab, GOOGLE_PAGE_WAIT_MS).catch(() => 0);
			pageResults = await extractResults(tab, maxResults - merged.length);
		} catch {
			// A page-2+ navigation/extraction error must not discard the page-1
			// results already in hand: degrade to the merged set.
			break;
		}
		let added = 0;
		for (const result of pageResults) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			merged.push(result);
			added++;
			if (merged.length >= maxResults) break;
		}
		// A page with zero NEW organics means the SERP is exhausted.
		if (added === 0) break;
		start += GOOGLE_PAGE_STRIDE;
	}
	return merged;
}

export async function waitForResults(tab, timeoutMs = 15000) {
	let lastCount = 0;
	const count = await waitForCondition(
		async (probeTimeoutMs) => {
			const found = await cdp(
				["eval", tab, "document.querySelectorAll('a[href^=\"http\"] h3').length"],
				probeTimeoutMs,
			).catch(() => "0");
			lastCount = parseInt(found, 10) || 0;
			return lastCount >= 3 ? lastCount : null;
		},
		{ timeoutMs, intervalMs: 100 },
	);
	return count || lastCount;
}

// ============================================================================
// Main
// ============================================================================

const USAGE =
	'Usage: node extractors/google-search.mjs "<query>" [--tab <prefix>] [--max <n>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	// Parse --max flag BEFORE parseArgs so it doesn't leak into query
	let maxResults = 10;
	const maxIdx = args.indexOf("--max");
	const cleanArgs = [...args];
	if (maxIdx !== -1) {
		maxResults = parseInt(args[maxIdx + 1], 10) || 10;
		cleanArgs.splice(maxIdx, 2); // Remove --max and its value
	}

	const { query, tabPrefix } = parseArgs(cleanArgs);

	let tab;
	let caughtError;
	let timingExtra;
	try {
		await cdp(["list"]);
		tab = await getOrOpenTab(tabPrefix);
		markPhase("setup");

		// Navigate to google.com. The input condition below replaces the old
		// unconditional post-navigation sleep; slow pages remain bounded.
		await cdp(["nav", tab, "https://www.google.com"], 35000);
		markPhase("homepageLoad");
		await dismissConsent(tab, cdp);
		markPhase("consent");

		const ready = await waitForCondition(
			async (probeTimeoutMs) => {
				const found = await cdp(
					[
						"eval",
						tab,
						`!!document.querySelector('${SEARCH_BOX.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`,
					],
					probeTimeoutMs,
				).catch(() => "false");
				return found === "true";
			},
			{ timeoutMs: 15000, intervalMs: 100 },
		);
		markPhase("inputWait");
		if (!ready)
			throw new Error("Google search box did not appear within 15000ms");

		// Type query and submit. Verify the value instead of sleeping for a fixed
		// post-type interval, preserving a bounded fallback for slow hydration.
		await typeIntoSearchBox(tab, query);
		const typed = await waitForCondition(
			async (probeTimeoutMs) => {
				const value = await cdp(
					[
						"eval",
						tab,
						`document.querySelector('${SEARCH_BOX.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')?.value === ${jsEvalLiteral(query)}`,
					],
					probeTimeoutMs,
				).catch(() => "false");
				return value === "true";
			},
			{ timeoutMs: 3000, intervalMs: 100 },
		);
		markPhase("typing");
		if (!typed) throw new Error("Google search box did not accept the query");
		await submitSearch(tab);
		markPhase("submit");

		// Require the requested search URL before inspecting headings. This
		// prevents a caller-supplied tab's previous result DOM from satisfying
		// the result condition during the submit/navigation gap.
		const navigated = await waitForCondition(
			async (probeTimeoutMs) => {
				const state = await cdp(
					[
						"eval",
						tab,
						`(() => { try { const u = new URL(location.href); const h = u.hostname.toLowerCase(); const googleHost = h === "google.com" || h.endsWith(".google.com") || new RegExp(${JSON.stringify(GOOGLE_REGIONAL_HOST_RE.source)}).test(h); return u.protocol === "https:" && googleHost && u.pathname === "/search" && u.searchParams.get("q") === ${jsEvalLiteral(query)}; } catch { return false; } })()`,
					],
					probeTimeoutMs,
				).catch(() => "false");
				return state === "true";
			},
			{ timeoutMs: 15000, intervalMs: 100 },
		);
		if (!navigated)
			throw new Error(
				"Google search navigation did not reach the requested query",
			);

		// Wait for results with immediate, condition-driven probes.
		const count = await waitForResults(tab, 15000);
		markPhase("resultsLoad");

		// Extract results. Google renders only ~8-10 organics per SERP page
		// (the `num` param is deprecated and ignored), so when maxResults
		// exceeds one page we paginate through ?start=10, ?start=20, … using
		// the same mechanism as Google's own "Next" links, merging and
		// URL-deduping pages until maxResults is reached, the SERP runs out
		// of new organics, or the caller's deadline is exhausted. Each extra
		// page is bounded (2.5s wait + extraction) so a sparse last page
		// cannot burn the whole search.
		const results = await extractPaginatedResults(tab, query, maxResults);
		if (count === 0 || results.length === 0)
			throw new Error("No search results found on page");
		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
		);
		markPhase("extraction");

		timingExtra = { ok: true, resultCount: results.length };

		outputJson({
			query,
			url: finalUrl,
			results,
		});
	} catch (e) {
		caughtError = e;
	} finally {
		// A caller-supplied tab belongs to the caller; only tear down tabs we made.
		if (!tabPrefix && tab) await closeTarget(tab);
	}
	if (caughtError)
		timingExtra = {
			ok: false,
			error: String(caughtError?.message || caughtError),
		};
	if (timingExtra)
		emitPhaseTimings({
			...timingExtra,
			totalMs: Date.now() - searchStartedAt,
		});
	// handleError exits the process, so invoke it only after teardown completes.
	if (caughtError) handleError(caughtError);
}

// Tests import the condition helpers without starting a live extractor.
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => handleError(error));
}
