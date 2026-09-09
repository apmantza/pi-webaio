/**
 * pi-webaio CLI — the third surface of the SDK runtime.
 *
 * The CLI is a thin argv parser over runTool() from src/sdk.ts — the exact
 * business logic the pi extension and MCP server run (no forking). Tool
 * modules load lazily on first call, and initRuntime() warms the session
 * caches and user-defined verticals, matching the pi extension's startup.
 *
 * Usage:
 *   pi-webaio-cli <tool> [params...]      Run a tool
 *   pi-webaio-cli list                    List all 8 tools
 *   pi-webaio-cli --json <tool> ...       Print structured JSON result
 *   pi-webaio-cli --help                  Show usage
 *
 * Params:
 *   Single JSON object positional:
 *     pi-webaio-cli aio-websearch '{"query":"hello"}'
 *   Key-value flags (values are JSON-parsed when they look like JSON):
 *     pi-webaio-cli aio-websearch --query hello --max 5
 *     pi-webaio-cli aio-webfetch --url https://example.com --format markdown
 *   A flag with no value becomes true (e.g. --compact).
 *
 * Exit codes: 0 success, 1 tool error, 2 usage/argument error.
 */
import { isTool, listTools, runTool } from "./sdk.ts";

/** A JSON value — the shape the SDK's tool params accept. */
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [k: string]: JsonValue };

/** Parse a single flag value: JSON when it looks like JSON, else a string. */
function parseValue(raw: string): JsonValue {
	const trimmed = raw.trim();
	if (trimmed === "") return "";
	try {
		return JSON.parse(trimmed);
	} catch {
		// Not JSON — keep as a plain string.
		return trimmed;
	}
}

/**
 * Parse tool params from the argv tail.
 *
 * Two shapes:
 *   - a single JSON object positional: '{"query":"hello"}'
 *   - key-value flags: --query hello --max 5 --compact
 */
function parseParams(rest: string[]): Record<string, unknown> {
	if (rest.length === 0) return {};
	if (rest[0].trim().startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rest[0]);
		} catch {
			throw new Error("Invalid JSON positional — not valid JSON");
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("JSON positional must be an object");
		}
		return parsed as Record<string, unknown>;
	}
	const params: Record<string, unknown> = {};
	let i = 0;
	while (i < rest.length) {
		const arg = rest[i];
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		const eq = arg.indexOf("=");
		if (eq >= 0) {
			const key = arg.slice(2, eq);
			params[key] = parseValue(arg.slice(eq + 1));
		} else {
			const key = arg.slice(2);
			const value = rest[i + 1];
			if (value === undefined || value.startsWith("--")) {
				// Flag with no value → boolean true.
				params[key] = true;
			} else {
				params[key] = parseValue(value);
				i++;
			}
		}
		i++;
	}
	return params;
}

function errMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function printUsage(): void {
	const tools = listTools();
	const lines = [
		"pi-webaio-cli — the SDK runtime behind an argv parser.",
		"",
		"Usage:",
		"  pi-webaio-cli <tool> [params...]      Run a tool",
		"  pi-webaio-cli list                    List all 8 tools",
		"  pi-webaio-cli --json <tool> ...       Print structured JSON result",
		"  pi-webaio-cli --help                  Show this help",
		"",
		"Params:",
		"  Single JSON object positional:",
		"    pi-webaio-cli aio-websearch '{\"query\":\"hello\"}'",
		"  Key-value flags (values are JSON-parsed when they look like JSON):",
		"    pi-webaio-cli aio-websearch --query hello --max 5",
		"    pi-webaio-cli aio-webfetch --url https://example.com --format markdown",
		"  A flag with no value becomes true (e.g. --compact).",
		"",
		"Tools:",
	];
	for (const t of tools) {
		lines.push(`  ${t.name.padEnd(14)} ${t.description}`);
	}
	process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Run the CLI. Returns the process exit code.
 *
 * CLI-level flags (`--json`, `--help`, `-h`) must precede the tool name;
 * everything after the tool name is tool params.
 */
export async function main(argv: string[]): Promise<number> {
	const args = argv.slice(2);
	let jsonMode = false;
	let rest = args;
	if (args[0] === "--json") {
		jsonMode = true;
		rest = args.slice(1);
	}
	if (rest.length === 0) {
		printUsage();
		return 2;
	}
	const cmd = rest[0];
	if (cmd === "--help" || cmd === "-h") {
		printUsage();
		return 0;
	}
	if (cmd === "list") {
		const tools = listTools();
		if (jsonMode) {
			process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
		} else {
			for (const t of tools) {
				process.stdout.write(`${t.name}\t${t.label}\t${t.description}\n`);
			}
		}
		return 0;
	}
	if (!isTool(cmd)) {
		process.stderr.write(`Unknown tool: ${cmd}\n\n`);
		printUsage();
		return 2;
	}
	let params: Record<string, unknown>;
	try {
		params = parseParams(rest.slice(1));
	} catch (err) {
		process.stderr.write(`Error parsing arguments: ${errMessage(err)}\n`);
		return 2;
	}
	try {
		const result = await runTool(cmd, params);
		if (jsonMode) {
			process.stdout.write(
				JSON.stringify(
					{ tool: cmd, text: result.text, details: result.details },
					null,
					2,
				) + "\n",
			);
		} else {
			process.stdout.write(result.text + "\n");
		}
		return 0;
	} catch (err) {
		process.stderr.write(`Tool error (${cmd}): ${errMessage(err)}\n`);
		return 1;
	}
}
