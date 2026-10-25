import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const compilerDir = dirname(require.resolve("typescript/package.json"));
const root = resolve(import.meta.dirname, "..");

for (const placement of ["ancestor", "local"]) {
	// Recurrence: Windows git install found a home-level compiler and checked
	// sources without dev/peer types, producing 239 errors instead of dist/.
	test(`npm production prepare emits with ${placement} TypeScript and missing types`, () => {
		const base = join(root, ".pi", "prepare-tests");
		mkdirSync(base, { recursive: true });
		const scratch = mkdtempSync(join(base, "install-"));
		try {
			const project = join(scratch, "package");
			mkdirSync(join(project, "scripts"), { recursive: true });
			copyFileSync(join(root, "scripts", "prepare.mjs"), join(project, "scripts", "prepare.mjs"));
			copyFileSync(join(root, "tsconfig.json"), join(project, "tsconfig.json"));
			copyFileSync(join(root, "tsconfig.dist.json"), join(project, "tsconfig.dist.json"));
			writeFileSync(join(project, "package.json"), JSON.stringify({
				name: "prepare-install-regression", version: "1.0.0", type: "module",
				scripts: { prepare: "node scripts/prepare.mjs" },
			}));
			writeFileSync(join(project, "index.ts"), 'process.stdout.write("installed successfully");\n');
			const modules = join(placement === "local" ? project : scratch, "node_modules");
			mkdirSync(modules, { recursive: true });
			symlinkSync(compilerDir, join(modules, "typescript"), process.platform === "win32" ? "junction" : "dir");
			const home = join(scratch, "home");
			mkdirSync(home);
			const env = { ...process.env, HOME: home, USERPROFILE: home,
				XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home,
				TMPDIR: scratch, TMP: scratch, TEMP: scratch,
				npm_config_cache: join(scratch, "npm-cache"), npm_config_userconfig: join(home, ".npmrc") };
			const install = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
				["install", "--omit=dev", "--legacy-peer-deps", "--offline", "--no-audit", "--no-fund"],
				{ cwd: project, env, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32" });
			assert.equal(install.status, 0, `${install.error ?? ""}\n${install.stdout}\n${install.stderr}`);
			assert.ok(existsSync(join(project, "dist", "index.d.ts")), "declaration output missing");
			const run = spawnSync(process.execPath, [join(project, "dist", "index.js")], { env, encoding: "utf8" });
			assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stderr}`);
			assert.equal(run.stdout, "installed successfully");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}
