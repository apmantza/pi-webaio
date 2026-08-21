import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

// Exercise the actual missing-optional-peer path without mutating the test
// process's node_modules. The loader makes only pi-tui resolution fail; the
// compatibility module must catch that failure and leave tool registration
// usable for non-pi/MCP consumers.
test("TUI compatibility keeps websearch usable without pi-tui", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-webaio-tui-compat-"));
	const loaderPath = join(root, "missing-tui-loader.mjs");
	const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-tui") {
    const error = new Error("simulated missing optional pi-tui peer");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return nextResolve(specifier, context);
}
`;
	await writeFile(loaderPath, loader, "utf8");
	const websearchPath = fileURLToPath(
		new URL("../src/tools/websearch.ts", import.meta.url),
	);
	const script = `
const mod = await import(${JSON.stringify(pathToFileURL(websearchPath).href)});
let tool;
mod.registerWebsearchTool({ registerTool(def) { tool = def; } });
if (!tool) throw new Error("websearch tool did not register");
const component = tool.renderCall({ query: "fallback probe" }, { fg: (_, value) => value, bold: (value) => value });
if (!component || typeof component.render !== "function") throw new Error("missing fallback component");
console.log(component.render(80)[0]);
`;
	try {
		const result = await execFileAsync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--experimental-loader",
				pathToFileURL(loaderPath).href,
				"--input-type=module",
				"-e",
				script,
			],
			{ encoding: "utf8" },
		);
		assert.match(result.stdout, /aio-websearch/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
