import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { LAZY_TOOL_NAMES, registerLazyTools } from "../src/tools/lazy.ts";

const expectedNames = [
	"aio-websearch",
	"aio-webfetch",
	"aio-webcontent",
	"aio-webresult",
	"aio-webmap",
	"aio-webpull",
	"aio-webquery",
	"aio-webresearch",
];

test("lazy registration exposes all tools without executing implementations", () => {
	const registered = [];
	registerLazyTools({ registerTool: (tool) => registered.push(tool) });

	assert.deepEqual(LAZY_TOOL_NAMES, expectedNames);
	assert.deepEqual(
		registered.map((tool) => tool.name),
		expectedNames,
	);
	for (const tool of registered) {
		assert.equal(tool.parameters.type, "object");
		assert.equal(typeof tool.execute, "function");
	}

	const fetchTool = registered.find((tool) => tool.name === "aio-webfetch");
	const component = fetchTool.renderCall(
		{ url: "https://user:secret@example.com/page" },
		{ fg: (_color, value) => value, bold: (value) => value },
	);
	assert.equal(component.render(100).join("\n").includes("secret"), false);
});

test("lazy execution loads the selected implementation and delegates", async () => {
	const registered = [];
	registerLazyTools({ registerTool: (tool) => registered.push(tool) });

	const result = await registered
		.find((tool) => tool.name === "aio-webresult")
		.execute("test-call", { id: "missing-startup-test-result" });

	assert.equal(Array.isArray(result.content), true);
	assert.match(result.content[0].text, /No result found for ID/);
});

test("PI_TIMING emits a structured startup record without loading tool modules", async () => {
	const script = [
		"process.env.TEMP = process.cwd() + '/.pi-startup-test-missing';",
		"process.env.TMP = process.env.TEMP;",
		"const started = performance.now();",
		"const mod = await import('./index.ts');",
		"const tools = [];",
		"mod.default({registerTool(tool) { tools.push(tool); }});",
		"console.log(JSON.stringify({elapsedMs: Math.round(performance.now() - started), count: tools.length}));",
	].join(" ");

	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", script],
		{
			cwd: process.cwd(),
			env: { ...process.env, PI_TIMING: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const exitCode = await new Promise((resolve) => child.on("close", resolve));
	assert.equal(exitCode, 0, stderr);
	const timingLine = stderr
		.split(/\r?\n/)
		.find((line) => line.startsWith("startup-timing "));
	assert.ok(timingLine, stderr);
	const timing = JSON.parse(timingLine.slice("startup-timing ".length));
	assert.equal(timing.origin, "first-module-load");
	assert.equal(timing.networkFetches, 0);
	assert.equal(typeof timing.totalMs, "number");
	assert.equal(JSON.parse(stdout).count, expectedNames.length);
});
