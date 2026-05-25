import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getStoredContent } from "../session-store.ts";

export function registerWebcontentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "aio-webcontent",
		label: "Web Content",
		description:
			"Retrieve previously fetched content from session storage by URL. Content is stored automatically after every successful aio-webfetch or aio-webpull.",
		promptSnippet: "Get stored content from a previous fetch",
		promptGuidelines: [
			"Use aio-webcontent when you need the full content of a previously fetched URL without re-downloading.",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "URL of previously fetched content",
			}),
		}),

		async execute(_toolCallId: string, params: any): Promise<any> {
			const stored = getStoredContent(params.url);
			if (!stored) {
				return {
					content: [
						{
							type: "text",
							text: `No stored content found for ${params.url}`,
						},
					],
					details: { found: false },
				};
			}
			const text = [
				`Retrieved content for ${stored.url}`,
				stored.title ? `Title: ${stored.title}` : "",
				`Length: ${stored.content.length} chars`,
				"\n---\n",
				stored.content,
			]
				.filter(Boolean)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					found: true,
					title: stored.title,
					url: stored.url,
					timestamp: stored.timestamp,
					length: stored.content.length,
				},
			};
		},
	});
}
