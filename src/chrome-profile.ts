// TypeScript mirror of bin/chrome-profile.mjs (issue #127).
//
// The CDP Chrome profile directory was forked as string literals across 9
// sites in 6 files; all of them must resolve the SAME directory because
// Chrome writes DevToolsActivePort into its user-data-dir and bin/cdp.mjs's
// getWsUrl refuses to fall back to the user's main Chrome on a mismatch.
// This module is the single seam for the TS world (google-ai.ts,
// reddit_search.ts, _cdp-shared.ts); bin/launch.mjs and
// bin/google-cdp-broker.mjs import bin/chrome-profile.mjs directly.
//
// Why the logic exists twice (bin .mjs + this .ts) and why that is safe:
// bin scripts must run on older Node (no .ts imports), and src files cannot
// statically import bin/ because the relative path shifts between the
// source and dist layouts. tests/chrome-profile.test.mjs pins the two
// implementations to identical behavior — drift fails CI.
//
// Override contract (opt-in, issue #127):
//   PI_WEBAIO_CHROME_PROFILE_DIR unset or blank → legacy tmpdir default
//     (unchanged behavior; tmpdir keeps Google cookies out of persistent
//     storage unless the user opts in);
//   absolute path → honored (trimmed);
//   relative or garbage → throws. Fail closed: a half-applied override
//     would point children at a directory Chrome was not launched with.
import { isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";

/** The env var enabling the opt-in persistent profile (issue #127). */
export const CHROME_PROFILE_DIR_ENV = "PI_WEBAIO_CHROME_PROFILE_DIR";

/** Legacy default — byte-identical to the pre-#127 literals. */
function defaultChromeProfileDir(): string {
	return join(tmpdir(), "greedysearch-chrome-profile");
}

export function chromeProfileDir(
	env: Record<string, string | undefined> = process.env,
): string {
	const override = env[CHROME_PROFILE_DIR_ENV];
	if (override === undefined) return defaultChromeProfileDir();
	let candidate = override.trim();
	if (candidate === "") return defaultChromeProfileDir();
	// Leading ~ expands to the home directory (shells expand it, but env set
	// via systemd units / CI / APIs does not). Only bare ~ and ~/ or ~\ 
	// prefixes expand — ~user is deliberately not supported.
	if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
		candidate = join(homedir(), candidate.slice(1).replace(/^[/\\]+/, ""));
	}
	if (!isAbsolute(candidate)) {
		throw new Error(
			`${CHROME_PROFILE_DIR_ENV} must be an absolute path (got: "${override}"); ` +
				"unset it to use the default tmpdir profile",
		);
	}
	return candidate;
}
