import { TOOL_METADATA } from "./lazy.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getResult, listResults } from "../storage.ts";

export function registerWebresultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...TOOL_METADATA["aio-webresult"],
		async execute(_toolCallId: string, params: any): Promise<any> {
			const stored = await getResult(params.id);
			if (!stored) {
				const recent = await listResults(undefined, 5);
				return {
					content: [
						{
							type: "text",
							text: `No result found for ID: ${params.id}\n\nRecent results:\n${recent.map((r) => `  - ${r.id}: ${r.url} (${r.source})`).join("\n") || "  (none)"}`,
						},
					],
				};
			}
			const text = [
				`Retrieved result ${stored.id}`,
				`URL: ${stored.url}`,
				`Tool: ${stored.source}`,
				`Length: ${stored.content.length} chars`,
				"\n---\n",
				stored.content.length > 50000
					? stored.content.slice(0, 50000) + "\n\n[... truncated]"
					: stored.content,
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					id: stored.id,
					url: stored.url,
					tool: stored.source,
					timestamp: stored.createdAt,
					length: stored.content.length,
				},
			};
		},
	});
}
