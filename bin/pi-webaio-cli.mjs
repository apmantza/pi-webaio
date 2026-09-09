#!/usr/bin/env node
/**
 * pi-webaio CLI entry point.
 *
 * Runs the SDK runtime behind an argv parser — the third surface alongside
 * the pi extension and the MCP server. All eight aio-* tools are callable
 * without the pi coding-agent runtime.
 *
 * Usage:
 *   npx -y pi-webaio-cli aio-websearch '{"query":"hello"}'
 *   node /path/to/bin/pi-webaio-cli.mjs aio-webfetch --url https://example.com
 *
 * stdout is the tool result; errors go to stderr.
 */

// Resolve dist path relative to this file so the script works both when
// installed globally (node_modules/.bin) and when run from the source tree.
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, "..", "dist", "src", "cli.js");

const { main } = await import(pathToFileURL(cliPath).href);

// Set exitCode (not process.exit) so pending stdout writes flush.
main(process.argv).then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		process.stderr.write(`pi-webaio-cli fatal error: ${err?.message ?? err}\n`);
		process.exitCode = 1;
	},
);
