import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { storeResult, getResult, listResults } from "../storage.ts";

export function registerWebresultTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webresult",
		label: "Get Stored Result",
		description:
			"Retrieve a previously fetched web scrape result by response ID. Results are stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Retrieve a stored web scrape by response ID",
		promptGuidelines: [
			"Use aio-webresult when you need to retrieve a previously fetched result by its response ID.",
			"Response IDs are shown after every successful aio-webfetch call.",
			"Use aio-webcontent to retrieve content by URL instead of by ID.",
		],
		parameters: Type.Object({
			id: Type.String({
				description: "Response ID from a previous webfetch call",
			}),
		}),

		async execute(_toolCallId: string, params: any): Promise<any> {
			const stored = await getResult(params.id);
			if (!stored) {
				const recent = (await listResults()).slice(0, 5);
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
