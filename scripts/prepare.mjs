import { existsSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { dirname, join } from "node:path";

// Resolve the tsc JS entry directly: node_modules/.bin/tsc is a shell shim on
// Windows, so it cannot be executed with node there.
//
// We resolve the always-exported `typescript/package.json` and join `bin/tsc`
// rather than resolving `typescript/bin/tsc` directly: typescript@7 added an
// `exports` map that does NOT expose the `./bin/tsc` subpath, so a direct
// resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED even when devDeps are present
// (the file still exists on disk; it is just not subpath-resolvable).
// Resolving `./package.json` works under both TS6 and TS7.
let tscPath;
try {
	const req = createRequire(import.meta.url);
	tscPath = join(dirname(req.resolve("typescript/package.json")), "bin", "tsc");
} catch (err) {
	// devDependencies not installed (e.g. npm install --omit=dev — which is
	// exactly how pi installs git packages): typescript is genuinely absent.
	// Do NOT skip the build — that silently leaves main/pi-entry pointing at
	// a missing dist/ and forces pi to jiti-transpile index.ts on every boot.
	// Match pi-free's production-install strategy: use the pinned local
	// compiler when available, otherwise fetch the exact compiler transiently
	// with npx instead of asking users to repair the checkout manually.
	if (err?.code === "MODULE_NOT_FOUND" || err?.code === "ERR_MODULE_NOT_FOUND") {
		rmSync("dist", { recursive: true, force: true });
		const npxArgs = [
			"--yes",
			"-p",
			"typescript@7.0.2",
			"tsc",
			"--project",
			"tsconfig.dist.json",
		];
		const npxCli = [
			process.env.npm_execpath
				? join(dirname(process.env.npm_execpath), "npx-cli.js")
				: undefined,
			join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
		].find((candidate) => candidate !== undefined && existsSync(candidate));
		if (npxCli) {
			execFileSync(process.execPath, [npxCli, ...npxArgs], {
				stdio: "inherit",
			});
		} else {
			const npx = process.platform === "win32" ? "npx.cmd" : "npx";
			execFileSync(npx, npxArgs, {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
		}
		process.exit(0);
	}
	// Any other resolution error must fail the build loudly rather than
	// silently skipping dist (which is how the TS7 exports breakage hid
	// itself).
	throw err;
}

rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, [tscPath, "--project", "tsconfig.dist.json"], {
	stdio: "inherit",
});
