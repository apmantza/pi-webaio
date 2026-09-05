import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temp = mkdtempSync(join(tmpdir(), "pi-webaio-webfetch-package-"));
let tarball;

function run(command, args, cwd, env = process.env) {
	return execFileSync(command, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function filesBelow(directory, prefix = "") {
	const entries = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) entries.push(...filesBelow(join(directory, entry.name), relative));
		else entries.push(relative);
	}
	return entries.sort();
}

try {
	run(npm, ["run", "build:dist"], root);
	const pack = JSON.parse(run(npm, ["pack", "--json", "--ignore-scripts"], root));
	tarball = resolve(root, pack[0].filename);
	const consumer = join(temp, "consumer");
	const state = join(temp, "state");
	mkdirSync(consumer, { recursive: true });
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(consumer, "package.json"),
		JSON.stringify({ name: "pi-webaio-static-api-smoke", private: true, type: "module" }),
	);
	const isolatedEnv = {
		...process.env,
		HOME: state,
		TMPDIR: state,
		TEMP: state,
		TMP: state,
	};
	run(
		npm,
		["install", "--ignore-scripts", "--omit=peer", tarball],
		consumer,
		isolatedEnv,
	);

	// The static entrypoint must load without either browser implementation or
	// pi's host-provided peer packages. Keep wreq's platform binding installed.
	for (const browserPackage of ["playwright", "playwright-core"]) {
		rmSync(join(consumer, "node_modules", browserPackage), {
			recursive: true,
			force: true,
		});
		assert.equal(existsSync(join(consumer, "node_modules", browserPackage)), false);
	}
	rmSync(join(consumer, "node_modules", "@earendil-works"), {
		recursive: true,
		force: true,
	});
	const before = filesBelow(state);
	writeFileSync(
		join(consumer, "smoke.mjs"),
		`import assert from "node:assert/strict";
const before = new Set(process._getActiveHandles());
const api = await import("pi-webaio/webfetch");
assert.equal(typeof api.fetch, "function");
assert.equal(typeof api.fetchPage, "function");
assert.equal(api.createStaticWebFetcher, undefined);
await new Promise((resolve) => setImmediate(resolve));
const unexpected = process._getActiveHandles().filter((handle) =>
  !before.has(handle) && ![process.stdin, process.stdout, process.stderr].includes(handle),
);
assert.deepEqual(unexpected.map((handle) => handle.constructor?.name ?? "unknown"), []);
`,
	);
	run(process.execPath, ["smoke.mjs"], consumer, isolatedEnv);
	assert.deepEqual(filesBelow(state), before);
	console.log(`Static webfetch package smoke passed: ${basename(tarball)}`);
} finally {
	if (tarball) rmSync(tarball, { force: true });
	rmSync(temp, { recursive: true, force: true });
}
