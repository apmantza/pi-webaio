declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		registerTool(tool: {
			name: string;
			label: string;
			description: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
			parameters?: unknown;
			execute: (
				toolCallId: string,
				params: any,
				signal?: AbortSignal,
				onUpdate?: (update: any) => void,
			) => Promise<unknown>;
		}): void;
	}
}
