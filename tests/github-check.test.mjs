// Tests for the new /commit/{sha}/checks/{check_id}/logs handler + gh CLI helpers
import { strict as assert } from "node:assert";
import { test } from "node:test";

// ─── parseGitHubCheckLogUrl ────────────────────────────────────────

test("parseGitHubCheckLogUrl handles /checks/{id}/logs", async () => {
	const { parseGitHubCheckLogUrl } = await import("../src/github-pipeline.ts");
	const r = parseGitHubCheckLogUrl(
		"https://github.com/apmantza/pi-drykiss/commit/e94f986806942af88c5f848101decfaf4dac88a0/checks/78945794182/logs",
	);
	assert.ok(r);
	assert.strictEqual(r.owner, "apmantza");
	assert.strictEqual(r.repo, "pi-drykiss");
	assert.strictEqual(r.sha, "e94f986806942af88c5f848101decfaf4dac88a0");
	assert.strictEqual(r.checkId, "78945794182");
	assert.strictEqual(r.step, null);
});

test("parseGitHubCheckLogUrl handles /checks/{id}/logs/{step}", async () => {
	const { parseGitHubCheckLogUrl } = await import("../src/github-pipeline.ts");
	const r = parseGitHubCheckLogUrl(
		"https://github.com/owner/repo/commit/abc123/checks/999/logs/5",
	);
	assert.ok(r);
	assert.strictEqual(r.checkId, "999");
	assert.strictEqual(r.step, "5");
});

test("parseGitHubCheckLogUrl rejects non-GitHub URLs", async () => {
	const { parseGitHubCheckLogUrl } = await import("../src/github-pipeline.ts");
	assert.strictEqual(
		parseGitHubCheckLogUrl(
			"https://gitlab.com/owner/repo/commit/abc/checks/1/logs",
		),
		null,
	);
	assert.strictEqual(
		parseGitHubCheckLogUrl("https://github.com/owner/repo"),
		null,
	);
	assert.strictEqual(
		parseGitHubCheckLogUrl("https://github.com/owner/repo/commit/abc"),
		null,
	);
	assert.strictEqual(parseGitHubCheckLogUrl("not a url"), null);
});

test("parseGitHubCheckLogUrl rejects non-numeric check_id", async () => {
	const { parseGitHubCheckLogUrl } = await import("../src/github-pipeline.ts");
	assert.strictEqual(
		parseGitHubCheckLogUrl(
			"https://github.com/owner/repo/commit/abc/checks/xyz/logs",
		),
		null,
	);
});

// ─── parseGitHubActionsLogsApiUrl ──────────────────────────────────

test("parseGitHubActionsLogsApiUrl handles api.github.com actions logs endpoint", async () => {
	const { parseGitHubActionsLogsApiUrl } = await import(
		"../src/github-pipeline.ts"
	);
	const r = parseGitHubActionsLogsApiUrl(
		"https://api.github.com/repos/apmantza/pi-drykiss/actions/runs/27479618304/logs",
	);
	assert.ok(r);
	assert.strictEqual(r.owner, "apmantza");
	assert.strictEqual(r.repo, "pi-drykiss");
	assert.strictEqual(r.runId, "27479618304");
});

test("parseGitHubActionsLogsApiUrl rejects non-api hostnames", async () => {
	const { parseGitHubActionsLogsApiUrl } = await import(
		"../src/github-pipeline.ts"
	);
	assert.strictEqual(
		parseGitHubActionsLogsApiUrl(
			"https://github.com/apmantza/pi-drykiss/actions/runs/27479618304/logs",
		),
		null,
	);
	assert.strictEqual(
		parseGitHubActionsLogsApiUrl(
			"https://api.github.com/repos/apmantza/pi-drykiss/actions/runs/27479618304",
		),
		null,
	);
	assert.strictEqual(parseGitHubActionsLogsApiUrl("not a url"), null);
});

// ─── filterLogByStepName (new primary filter) ──────────────────────

test("filterLogByStepName returns the section for a given step", async () => {
	const { filterLogByStepName } = await import("../src/github-pipeline.ts");
	const log = [
		"Set up job\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z ##[group]Runner Image",
		"Set up job\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z Runner Image: ubuntu-22.04",
		"Set up job\tcompleted\t2026-06-01T20:50:01.0000000Z Job complete",
		"Checkout code\tUNKNOWN STEP\t2026-06-01T20:50:02.0000000Z Cloning repo",
		"Checkout code\tUNKNOWN STEP\t2026-06-01T20:50:03.0000000Z Done",
		"Checkout code\tcompleted\t2026-06-01T20:50:04.0000000Z Job complete",
		"Type-check & unit tests\tUNKNOWN STEP\t2026-06-01T20:50:05.0000000Z Running tests",
		"Type-check & unit tests\tUNKNOWN STEP\t2026-06-01T20:50:06.0000000Z ##[error]TS2554: Expected 1 arguments, but got 0.",
		"Type-check & unit tests\tcompleted\t2026-06-01T20:50:07.0000000Z Process completed with exit code 2.",
	].join("\n");
	const section = filterLogByStepName(log, "Checkout code");
	// Should contain only Checkout code lines (3 lines)
	assert.ok(section.includes("Cloning repo"));
	assert.ok(section.includes("Done"));
	assert.ok(section.includes("Job complete"));
	// Should NOT contain lines from other steps
	assert.ok(!section.includes("Runner Image"));
	assert.ok(!section.includes("Running tests"));
	assert.ok(!section.includes("TS2554"));
});

test("filterLogByStepName returns the section for the last step (no following boundary)", async () => {
	const { filterLogByStepName } = await import("../src/github-pipeline.ts");
	const log = [
		"Step A\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z line 1",
		"Step A\tcompleted\t2026-06-01T20:50:01.0000000Z done",
		"Step B\tUNKNOWN STEP\t2026-06-01T20:50:02.0000000Z line 1",
		"Step B\tUNKNOWN STEP\t2026-06-01T20:50:03.0000000Z line 2",
		"Step B\tcompleted\t2026-06-01T20:50:04.0000000Z done",
	].join("\n");
	const section = filterLogByStepName(log, "Step B");
	assert.ok(section.includes("line 1"));
	assert.ok(section.includes("line 2"));
	assert.ok(section.includes("done"));
	assert.ok(!section.includes("Step A"));
});

test("filterLogByStepName returns the section for the first step", async () => {
	const { filterLogByStepName } = await import("../src/github-pipeline.ts");
	const log = [
		"Step A\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z line 1",
		"Step A\tcompleted\t2026-06-01T20:50:01.0000000Z done",
		"Step B\tUNKNOWN STEP\t2026-06-01T20:50:02.0000000Z line 1",
		"Step B\tcompleted\t2026-06-01T20:50:03.0000000Z done",
	].join("\n");
	const section = filterLogByStepName(log, "Step A");
	assert.ok(section.includes("Step A\tUNKNOWN STEP"));
	assert.ok(section.includes("Step A\tcompleted"));
	assert.ok(!section.includes("Step B"));
});

test("filterLogByStepName returns the only step in a single-step log", async () => {
	const { filterLogByStepName } = await import("../src/github-pipeline.ts");
	const log = [
		"Type-check\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z line 1",
		"Type-check\tUNKNOWN STEP\t2026-06-01T20:50:01.0000000Z line 2",
		"Type-check\tcompleted\t2026-06-01T20:50:02.0000000Z done",
	].join("\n");
	const section = filterLogByStepName(log, "Type-check");
	assert.ok(section === log, "single-step log should be returned in full");
});

test("filterLogByStepName returns the original log if the step is not found", async () => {
	const { filterLogByStepName } = await import("../src/github-pipeline.ts");
	const log = [
		"Step A\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z line 1",
		"Step A\tcompleted\t2026-06-01T20:50:01.0000000Z done",
	].join("\n");
	const section = filterLogByStepName(log, "Nonexistent Step");
	assert.strictEqual(section, log, "should return original log unchanged");
});

test("filterLogByStepName handles step names with spaces and special chars", async () => {
	const { filterLogByStepName } = await import("../src/github-pipeline.ts");
	const log = [
		"Type-check & unit tests\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z running",
		"Type-check & unit tests\tcompleted\t2026-06-01T20:50:01.0000000Z done",
		"Build docs / publish\tUNKNOWN STEP\t2026-06-01T20:51:00.0000000Z building",
		"Build docs / publish\tcompleted\t2026-06-01T20:51:01.0000000Z done",
	].join("\n");
	const a = filterLogByStepName(log, "Type-check & unit tests");
	assert.ok(a.includes("running"));
	assert.ok(!a.includes("building"));
	const b = filterLogByStepName(log, "Build docs / publish");
	assert.ok(b.includes("building"));
	assert.ok(!b.includes("running"));
});

test("filterLogByStepName skips non-tab lines before the step (headers)", async () => {
	const { filterLogByStepName } = await import("../src/github-pipeline.ts");
	const log = [
		"##[group]Runner Image",
		"##[endgroup]",
		"Step A\tUNKNOWN STEP\t2026-06-01T20:50:00.0000000Z real line",
		"Step A\tcompleted\t2026-06-01T20:50:01.0000000Z done",
	].join("\n");
	const section = filterLogByStepName(log, "Step A");
	assert.ok(section.includes("real line"));
	assert.ok(section.includes("done"));
	assert.ok(!section.includes("Runner Image"));
});

// ─── getStepNamesInOrder ───────────────────────────────────────────

test("getStepNamesInOrder returns unique steps in order of first appearance", async () => {
	const { getStepNamesInOrder } = await import("../src/github-pipeline.ts");
	const log = [
		"Step C\tUNKNOWN STEP\t... line",
		"Step A\tUNKNOWN STEP\t... line",
		"Step C\tUNKNOWN STEP\t... line",
		"Step B\tUNKNOWN STEP\t... line",
		"Step A\tUNKNOWN STEP\t... line",
	].join("\n");
	const names = getStepNamesInOrder(log);
	assert.deepStrictEqual(names, ["Step C", "Step A", "Step B"]);
});

test("getStepNamesInOrder returns empty array for empty log", async () => {
	const { getStepNamesInOrder } = await import("../src/github-pipeline.ts");
	assert.deepStrictEqual(getStepNamesInOrder(""), []);
	assert.deepStrictEqual(getStepNamesInOrder("no tab lines here\nat all"), []);
});

// ─── filterLogByGroupMarker (fallback) ─────────────────────────────

test("filterLogByGroupMarker finds section by index", async () => {
	const { filterLogByGroupMarker } = await import("../src/github-pipeline.ts");
	const log = [
		"##[group]Step A",
		"line 1",
		"line 2",
		"##[endgroup]",
		"##[group]Step B",
		"line 3",
		"line 4",
		"##[endgroup]",
		"##[group]Step C",
		"line 5",
		"##[endgroup]",
	].join("\n");
	const section = filterLogByGroupMarker(log, "2");
	assert.ok(section.startsWith("##[group]Step B"));
	assert.ok(section.includes("line 3"));
	assert.ok(section.includes("line 4"));
	assert.ok(section.includes("##[endgroup]"));
	assert.ok(!section.includes("##[group]Step A"));
	assert.ok(!section.includes("##[group]Step C"));
	assert.ok(!section.includes("line 5"));
});

test("filterLogByGroupMarker returns the last group when no follow-up marker exists", async () => {
	const { filterLogByGroupMarker } = await import("../src/github-pipeline.ts");
	const log = ["##[group]Step A", "line 1", "##[group]Step B", "line 2"].join(
		"\n",
	);
	const section = filterLogByGroupMarker(log, "2");
	assert.ok(section.includes("Step B"));
	assert.ok(section.includes("line 2"));
	assert.ok(!section.includes("Step A"));
});

test("filterLogByGroupMarker returns unchanged log if no markers", async () => {
	const { filterLogByGroupMarker } = await import("../src/github-pipeline.ts");
	const log = "no group markers here\njust plain log lines";
	assert.strictEqual(filterLogByGroupMarker(log, "1"), log);
});

test("filterLogByGroupMarker returns unchanged log if index is out of range", async () => {
	const { filterLogByGroupMarker } = await import("../src/github-pipeline.ts");
	const log = ["##[group]Step A", "line 1"].join("\n");
	assert.strictEqual(filterLogByGroupMarker(log, "5"), log);
});

test("filterLogByGroupMarker rejects invalid index", async () => {
	const { filterLogByGroupMarker } = await import("../src/github-pipeline.ts");
	const log = ["##[group]Step A", "line 1"].join("\n");
	assert.strictEqual(filterLogByGroupMarker(log, null), log);
	assert.strictEqual(filterLogByGroupMarker(log, "abc"), log);
	assert.strictEqual(filterLogByGroupMarker(log, "0"), log);
	assert.strictEqual(filterLogByGroupMarker(log, "-1"), log);
});

// ─── Integration: full pipeline call ───────────────────────────────

test("pullGitHub with check log URL routes to check log handler", async () => {
	const { pullGitHub } = await import("../src/github-pipeline.ts");
	const url =
		"https://github.com/apmantza/pi-drykiss/commit/e94f986806942af88c5f848101decfaf4dac88a0/checks/78945794182/logs/5";
	const r = await pullGitHub(url);
	if (r === null) {
		console.log("  (skipped — network call failed)");
		return;
	}
	assert.strictEqual(r.ok, true);
	assert.match(r.title || "", /check/);
	// The content should mention the check name, log unavailability, or external CI.
	const hasCheckName = r.content?.includes("Type-check") ?? false;
	const hasLogUnavailable =
		r.content?.includes("Log content unavailable") ?? false;
	const hasExternalCINote = r.content?.includes("External CI check") ?? false;
	const hasViewOnGitHub = r.content?.includes("View on GitHub") ?? false;
	assert.ok(
		hasCheckName || hasLogUnavailable || hasExternalCINote || hasViewOnGitHub,
		"rendered markdown should reference the check",
	);
});

test("pullGitHub with /commit/{sha} still returns commit (not check log)", async () => {
	const { pullGitHub } = await import("../src/github-pipeline.ts");
	const url =
		"https://github.com/apmantza/pi-drykiss/commit/e94f986806942af88c5f848101decfaf4dac88a0";
	const r = await pullGitHub(url);
	if (r === null) {
		console.log("  (skipped — network call failed)");
		return;
	}
	assert.match(r.title || "", /commit/);
});

test("pullGitHub routes api.github.com actions logs endpoint to gh CLI", async () => {
	const { pullGitHub } = await import("../src/github-pipeline.ts");
	const url =
		"https://api.github.com/repos/apmantza/pi-drykiss/actions/runs/27479618304/logs";
	const r = await pullGitHub(url);
	if (r === null) {
		console.log("  (skipped — gh CLI unavailable or run not accessible)");
		return;
	}
	assert.strictEqual(r.ok, true);
	assert.match(r.title || "", /Actions run #27479618304/);
	assert.ok(r.content?.includes("via GitHub API + gh CLI"));
});

test("pullGitHub returns clear error for non-existent repo", async () => {
	const { pullGitHub } = await import("../src/github-pipeline.ts");
	const url =
		"https://github.com/nonexistent-org-definitely-fake-12345/nonexistent-repo-fake-67890";
	const r = await pullGitHub(url);
	if (r === null) {
		// Clone failed and API call also failed — null is acceptable
		return;
	}
	assert.strictEqual(r.ok, false);
	assert.match(r.error || "", /Not Found|not found|inaccessible/i);
});

// ─── gh CLI helpers ────────────────────────────────────────────────

test("ghApiCall throws when gh is not available", async () => {
	const { ghApiCall } = await import("../src/github-api.ts");
	const prev = process.env.PI_WEBAIO_GH_FALLBACK;
	process.env.PI_WEBAIO_GH_FALLBACK = "0";
	try {
		await assert.rejects(async () => await ghApiCall("/repos/foo/bar"));
	} finally {
		if (prev === undefined) delete process.env.PI_WEBAIO_GH_FALLBACK;
		else process.env.PI_WEBAIO_GH_FALLBACK = prev;
	}
});

test("ghFetchWithFallback still throws when gh fallback disabled", async () => {
	const { ghFetchWithFallback } = await import("../src/github-api.ts");
	const prev = process.env.PI_WEBAIO_GH_FALLBACK;
	process.env.PI_WEBAIO_GH_FALLBACK = "0";
	try {
		// Make a request to a non-existent repo: should fail with 404
		// and the gh fallback is disabled, so it throws.
		await assert.rejects(async () =>
			ghFetchWithFallback(
				"/repos/this-org-definitely-does-not-exist-12345/repo",
			),
		);
	} finally {
		if (prev === undefined) delete process.env.PI_WEBAIO_GH_FALLBACK;
		else process.env.PI_WEBAIO_GH_FALLBACK = prev;
	}
});
