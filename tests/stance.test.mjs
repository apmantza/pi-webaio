// ─── Tests for the deterministic claim-stance classifier (issue #70) ───
// All pure/offline: no LLM calls, no network. Verifies keyword overlap,
// conflict-marker matching, per-source classification, and verdict
// thresholds against small in-memory fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	STANCE_CAVEAT,
	CONFLICT_MARKERS,
	countConflictMarkers,
	keywordOverlapRatio,
	freshnessScore,
	classifySourceStance,
	summarizeStance,
	buildStanceMd,
	buildStanceJson,
} from "../src/research.ts";

// ─── Conflict-marker matching ───────────────────────────────────────────

test("CONFLICT_MARKERS: has a substantial English marker list (~30-40 terms)", () => {
	assert.ok(CONFLICT_MARKERS.length >= 30, "expected at least 30 conflict markers");
	assert.ok(CONFLICT_MARKERS.length <= 60, "marker list should stay small/auditable");
});

test("countConflictMarkers: matches whole words, not substrings", () => {
	const { count, matched } = countConflictMarkers("The claim was debunked by researchers.");
	assert.equal(count, 1);
	assert.deepEqual(matched, ["debunked"]);

	// "false" must not match inside "falsely" is fine either way, but a
	// distinct word like "falsehood" should not match "false" as a substring
	// unless it's actually a listed marker; sanity check word boundaries:
	const noMatch = countConflictMarkers("classifier");
	assert.equal(noMatch.count, 0);
});

test("countConflictMarkers: multi-word phrases like 'no evidence' match across whitespace", () => {
	const { count, matched } = countConflictMarkers("There is no evidence to support this claim.");
	assert.equal(count, 1);
	assert.deepEqual(matched, ["no evidence"]);
});

test("countConflictMarkers: counts multiple distinct markers and dedupes the matched list case-insensitively", () => {
	const { count, matched } = countConflictMarkers(
		"Officials say the report was DEBUNKED and later Debunked again, also called a myth.",
	);
	assert.equal(count, 3);
	assert.deepEqual(matched, ["debunked", "myth"]);
});

test("countConflictMarkers: empty/undefined text yields zero matches", () => {
	assert.deepEqual(countConflictMarkers(""), { count: 0, matched: [] });
	assert.deepEqual(countConflictMarkers(undefined), { count: 0, matched: [] });
});

// ─── Keyword overlap (reuses BM25 tokenization) ─────────────────────────

test("keywordOverlapRatio: 1.0 when all query terms are present", () => {
	const ratio = keywordOverlapRatio(
		"vaccine safety data",
		"New vaccine safety data was published this week showing strong results.",
	);
	assert.equal(ratio, 1);
});

test("keywordOverlapRatio: 0 for completely unrelated text", () => {
	const ratio = keywordOverlapRatio("vaccine safety data", "Gardening tips for spring tomatoes.");
	assert.equal(ratio, 0);
});

test("keywordOverlapRatio: partial overlap is a fraction between 0 and 1", () => {
	const ratio = keywordOverlapRatio("vaccine safety data trial", "The vaccine trial concluded early.");
	assert.ok(ratio > 0 && ratio < 1, `expected partial overlap, got ${ratio}`);
});

// ─── Freshness ───────────────────────────────────────────────────────────

test("freshnessScore: unknown/unparseable date is neutral (0.5)", () => {
	assert.equal(freshnessScore(undefined), 0.5);
	assert.equal(freshnessScore("not-a-date"), 0.5);
});

test("freshnessScore: recent date scores highest, old date scores lowest", () => {
	const now = new Date("2026-07-20T00:00:00.000Z");
	const recent = freshnessScore("2026-06-01T00:00:00.000Z", now);
	const old = freshnessScore("2010-01-01T00:00:00.000Z", now);
	assert.equal(recent, 1);
	assert.ok(old < recent);
});

// ─── classifySourceStance: supporting / conflicting / neutral fixtures ──

test("classifySourceStance: high keyword overlap + no conflict markers => supporting", () => {
	const stance = classifySourceStance({
		sourceId: "S1",
		url: "https://a.example.com",
		title: "A",
		text: "The new battery technology dramatically improves energy density and charging speed, confirming earlier lab results.",
		query: "new battery technology energy density charging speed",
		primary: false,
	});
	assert.equal(stance.label, "supporting");
	assert.ok(stance.evidenceStrength > 0);
	assert.equal(stance.conflictMarkerCount, 0);
});

test("classifySourceStance: high overlap + conflict markers => conflicting", () => {
	const stance = classifySourceStance({
		sourceId: "S2",
		url: "https://b.example.com",
		title: "B",
		text: "Claims about the new battery technology's energy density were debunked; researchers found no evidence for the reported charging speed gains.",
		query: "new battery technology energy density charging speed",
		primary: false,
	});
	assert.equal(stance.label, "conflicting");
	assert.ok(stance.evidenceStrength < 0);
	assert.ok(stance.conflictMarkerCount >= 1);
});

test("classifySourceStance: low keyword overlap => neutral regardless of conflict markers", () => {
	const stance = classifySourceStance({
		sourceId: "S3",
		url: "https://c.example.com",
		title: "C",
		text: "This article about local weather and traffic has nothing to do with the topic at hand.",
		query: "new battery technology energy density charging speed",
		primary: false,
	});
	assert.equal(stance.label, "neutral");
	assert.equal(stance.evidenceStrength, 0);
});

test("classifySourceStance: primary sources get a quality-tier boost to evidenceStrength", () => {
	const text =
		"The new battery technology dramatically improves energy density and charging speed, confirming earlier lab results.";
	const query = "new battery technology energy density charging speed";
	const secondary = classifySourceStance({ sourceId: "S1", url: "u", title: "t", text, query, primary: false });
	const primary = classifySourceStance({ sourceId: "S2", url: "u", title: "t", text, query, primary: true });
	assert.equal(secondary.label, "supporting");
	assert.equal(primary.label, "supporting");
	assert.ok(primary.evidenceStrength > secondary.evidenceStrength);
});

// ─── summarizeStance: verdict thresholds ────────────────────────────────

test("summarizeStance: no supporting/conflicting sources => insufficient_evidence", () => {
	const summary = summarizeStance("q", [
		{ sourceId: "S1", url: "u", title: "t", label: "neutral", keywordOverlap: 0.05, conflictMarkerCount: 0, conflictMarkersMatched: [], primary: false, freshness: 0.5, evidenceStrength: 0 },
	]);
	assert.equal(summary.verdict, "insufficient_evidence");
});

test("summarizeStance: strong, multi-source support with zero conflict => supported", () => {
	const src = (id, strength) => ({
		sourceId: id,
		url: "u",
		title: "t",
		label: "supporting",
		keywordOverlap: 0.9,
		conflictMarkerCount: 0,
		conflictMarkersMatched: [],
		primary: true,
		freshness: 1,
		evidenceStrength: strength,
	});
	const summary = summarizeStance("q", [src("S1", 1.0), src("S2", 0.8)]);
	assert.equal(summary.verdict, "supported");
	assert.equal(summary.supportingCount, 2);
	assert.equal(summary.conflictingCount, 0);
});

test("summarizeStance: single/weak support with zero conflict => likely_supported", () => {
	const summary = summarizeStance("q", [
		{ sourceId: "S1", url: "u", title: "t", label: "supporting", keywordOverlap: 0.4, conflictMarkerCount: 0, conflictMarkersMatched: [], primary: false, freshness: 0.5, evidenceStrength: 0.3 },
	]);
	assert.equal(summary.verdict, "likely_supported");
});

test("summarizeStance: strong, multi-source conflict with zero support => likely_false", () => {
	const src = (id, strength) => ({
		sourceId: id,
		url: "u",
		title: "t",
		label: "conflicting",
		keywordOverlap: 0.9,
		conflictMarkerCount: 2,
		conflictMarkersMatched: ["debunked"],
		primary: true,
		freshness: 1,
		evidenceStrength: strength,
	});
	const summary = summarizeStance("q", [src("S1", -1.0), src("S2", -0.9)]);
	assert.equal(summary.verdict, "likely_false");
	assert.equal(summary.conflictingCount, 2);
});

test("summarizeStance: weak/single conflicting source with zero support => contested", () => {
	const summary = summarizeStance("q", [
		{ sourceId: "S1", url: "u", title: "t", label: "conflicting", keywordOverlap: 0.4, conflictMarkerCount: 1, conflictMarkersMatched: ["myth"], primary: false, freshness: 0.5, evidenceStrength: -0.3 },
	]);
	assert.equal(summary.verdict, "contested");
});

test("summarizeStance: comparable support and conflict scores => contested", () => {
	const summary = summarizeStance("q", [
		{ sourceId: "S1", url: "u", title: "t", label: "supporting", keywordOverlap: 0.5, conflictMarkerCount: 0, conflictMarkersMatched: [], primary: false, freshness: 0.5, evidenceStrength: 0.5 },
		{ sourceId: "S2", url: "u", title: "t", label: "conflicting", keywordOverlap: 0.5, conflictMarkerCount: 1, conflictMarkersMatched: ["denied"], primary: false, freshness: 0.5, evidenceStrength: -0.5 },
	]);
	assert.equal(summary.verdict, "contested");
});

test("summarizeStance: support clearly dominates conflict => likely_supported", () => {
	const summary = summarizeStance("q", [
		{ sourceId: "S1", url: "u", title: "t", label: "supporting", keywordOverlap: 0.9, conflictMarkerCount: 0, conflictMarkersMatched: [], primary: true, freshness: 1, evidenceStrength: 1.5 },
		{ sourceId: "S2", url: "u", title: "t", label: "conflicting", keywordOverlap: 0.3, conflictMarkerCount: 1, conflictMarkersMatched: ["myth"], primary: false, freshness: 0.5, evidenceStrength: -0.2 },
	]);
	assert.equal(summary.verdict, "likely_supported");
});

// ─── STANCE.md / stance.json rendering ──────────────────────────────────

test("buildStanceMd: includes the caveat, verdict, and a candidate claim table", () => {
	const summary = summarizeStance("Is the new battery tech real?", [
		{ sourceId: "S1", url: "https://a.example.com", title: "A", label: "supporting", keywordOverlap: 0.8, conflictMarkerCount: 0, conflictMarkersMatched: [], primary: true, freshness: 1, evidenceStrength: 1.2 },
	]);
	const md = buildStanceMd(summary);
	assert.match(md, /not semantic entailment/i);
	assert.match(md, /non-authoritative/i);
	assert.match(md, /S1/);
	assert.match(md, new RegExp(STANCE_CAVEAT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildStanceMd: handles zero sources gracefully", () => {
	const summary = summarizeStance("q", []);
	const md = buildStanceMd(summary);
	assert.match(md, /No fetched sources/i);
});

test("buildStanceJson: shape includes caveat, verdict, counts, and per-source array", () => {
	const summary = summarizeStance("q", [
		{ sourceId: "S1", url: "u", title: "t", label: "supporting", keywordOverlap: 0.8, conflictMarkerCount: 0, conflictMarkersMatched: [], primary: false, freshness: 0.5, evidenceStrength: 0.5 },
	]);
	const json = buildStanceJson(summary);
	assert.equal(json.version, 1);
	assert.equal(json.caveat, STANCE_CAVEAT);
	assert.equal(json.verdict, summary.verdict);
	assert.equal(json.counts.supporting, 1);
	assert.ok(Array.isArray(json.sources));
	assert.equal(json.sources.length, 1);
});
