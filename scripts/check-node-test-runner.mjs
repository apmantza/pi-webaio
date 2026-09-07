#!/usr/bin/env node
// check-node-test-runner.mjs — pretest guard for `npm test` / `npm run test:all`.
//
// The suite imports TypeScript sources directly via Node's native
// type-stripping, which needs Node 24+ (older and some distro Node 22
// builds fail with a cryptic ERR_NO_TYPESCRIPT). The compiled extension
// itself runs fine on older Node — only the test runner has this floor —
// so instead of an `engines` field (which spams EBADENGINE warnings on
// every downstream install), fail fast here with a clear message.
//
// Plain JavaScript, zero dependencies; silent on success.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function canStripTypes() {
	const dir = mkdtempSync(join(tmpdir(), "pi-webaio-nodecheck-"));
	const probe = join(dir, "probe.mts");
	try {
		writeFileSync(probe, "const x: number = 1;\nconsole.log(x);\n");
		const out = execFileSync(
			process.execPath,
			["--experimental-strip-types", probe],
			{ encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] },
		);
		return out.trim() === "1";
	} catch {
		return false;
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
}

if (!canStripTypes()) {
	console.error(
		`[pi-webaio] tests require Node.js 24+ (native TypeScript type-stripping); current: ${process.version}.`,
	);
	console.error(
		"[pi-webaio] The compiled extension itself runs on older Node — only `npm test` / `npm run test:all` need 24.",
	);
	process.exit(1);
}
