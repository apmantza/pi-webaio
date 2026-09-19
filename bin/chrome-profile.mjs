// Single seam for the CDP Chrome profile directory (issue #127).
//
// The dir was forked as string literals across 9 sites in 6 files
// (launch.mjs, google-cdp-broker.mjs, google-ai.ts ×4, reddit_search.ts,
// _cdp-shared.ts ×2). All of them must resolve the SAME directory: Chrome
// writes DevToolsActivePort into its user-data-dir, and bin/cdp.mjs's
// getWsUrl refuses to fall back to the user's main Chrome when the path
// does not match. A missed site surfaced as "DevToolsActivePort not found".
//
// Why two implementations (see tests/chrome-profile.test.mjs, which pins
// them equal): bin scripts must run on older Node (the compiled extension
// supports it), where importing a .ts is unavailable; and src/*.ts cannot
// statically import bin/ because the relative path shifts between the
// source and dist layouts. src/chrome-profile.ts mirrors this rule for the
// TS world; the parity test makes drift a CI failure.
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

export const CHROME_PROFILE_DIR_ENV = "PI_WEBAIO_CHROME_PROFILE_DIR";

/** Legacy default — byte-identical to the pre-#127 literals. */
function defaultChromeProfileDir() {
	return join(tmpdir(), "greedysearch-chrome-profile");
}

export function chromeProfileDir(env = process.env) {
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
