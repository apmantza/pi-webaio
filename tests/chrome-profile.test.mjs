// Chrome CDP profile directory resolver (issue #127).
//
// Recurrence this prevents: the profile dir was forked as string literals
// across 9 sites in 6 files; an override (or any future default change)
// would have to be applied 9 times — miss one and a child resolving a
// different directory than the one Chrome was launched with fails with
// "DevToolsActivePort not found … Refusing to fall back to the main Chrome
// session" (bin/cdp.mjs getWsUrl).
//
// Two language-native implementations exist by constraint, pinned equal by
// this suite: bin/chrome-profile.mjs (plain JS — bin scripts must run on
// older Node, where .ts imports are unavailable) and src/chrome-profile.ts
// (TS — src files cannot statically import bin/ because the relative path
// shifts between source and dist layouts). Both must resolve the env var
// PI_WEBAIO_CHROME_PROFILE_DIR identically: unset/blank → tmpdir default
// (exact legacy behavior), absolute → honored, relative/garbage → throw.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CHROME_PROFILE_DIR_ENV as TS_ENV_NAME,
	chromeProfileDir as tsResolver,
} from "../src/chrome-profile.ts";
import {
	CHROME_PROFILE_DIR_ENV as BIN_ENV_NAME,
	chromeProfileDir as binResolver,
} from "../bin/chrome-profile.mjs";

const DEFAULT_DIR = join(tmpdir(), "greedysearch-chrome-profile");
const RESOLVERS = [
	["bin", binResolver],
	["src", tsResolver],
];

test("both implementations export the same env var name", () => {
	assert.equal(BIN_ENV_NAME, "PI_WEBAIO_CHROME_PROFILE_DIR");
	assert.equal(TS_ENV_NAME, BIN_ENV_NAME);
});

test("unset or blank override falls back to the legacy tmpdir default", () => {
	for (const [name, resolve] of RESOLVERS) {
		assert.equal(resolve({}), DEFAULT_DIR, `${name}: unset`);
		assert.equal(resolve({ [BIN_ENV_NAME]: "" }), DEFAULT_DIR, `${name}: empty`);
		assert.equal(resolve({ [BIN_ENV_NAME]: "   " }), DEFAULT_DIR, `${name}: blank`);
	}
});

test("absolute override is honored (trimmed)", () => {
	for (const [name, resolve] of RESOLVERS) {
		const dir = join(tmpdir(), "my-persistent-chrome-profile");
		assert.equal(
			resolve({ [BIN_ENV_NAME]: `  ${dir}  ` }),
			dir,
			`${name}: absolute override`,
		);
	}
});

test("relative or garbage override fails closed with a clear error", () => {
	for (const [name, resolve] of RESOLVERS) {
		for (const bad of ["relative/dir", ".", "./x"]) {
			assert.throws(
				() => resolve({ [BIN_ENV_NAME]: bad }),
				(err) => {
					assert.match(String(err?.message ?? err), /PI_WEBAIO_CHROME_PROFILE_DIR/);
					assert.match(String(err?.message ?? err), /absolute/);
					return true;
				},
				`${name}: "${bad}" must be rejected`,
			);
		}
	}
});

test("parity: both implementations agree on every scenario", () => {
	const scenarios = [
		{},
		{ [BIN_ENV_NAME]: "" },
		{ [BIN_ENV_NAME]: "   " },
		{ [BIN_ENV_NAME]: join(tmpdir(), "parity-profile") },
	];
	for (const env of scenarios) {
		const bin = (() => {
			try {
				return { ok: binResolver(env) };
			} catch (err) {
				return { threw: String(err?.message ?? err) };
			}
		})();
		const ts = (() => {
			try {
				return { ok: tsResolver(env) };
			} catch (err) {
				return { threw: String(err?.message ?? err) };
			}
		})();
		assert.deepEqual(ts, bin, `parity mismatch for env ${JSON.stringify(env)}`);
	}
});
