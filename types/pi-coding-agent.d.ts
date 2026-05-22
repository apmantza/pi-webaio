/**
 * Type augmentations for @earendil-works/pi-coding-agent.
 *
 * This file augments the real package types with the subset of ExtensionAPI
 * that pi-webaio uses at runtime. If the real package provides these types
 * natively (it does as of 0.74.0), this augmentation is a no-op safety net.
 *
 * The key interface is ExtensionAPI.registerTool(), which all 4 tools use.
 */

export {};

declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		/** Register a tool that the LLM can call. */
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
			/** Custom rendering for tool call display in TUI */
			renderCall?: (args: any, theme: any) => any;
			/** Custom rendering for tool result display in TUI */
			renderResult?: (result: any, options: any, theme: any) => any;
		}): void;

		/** Register a slash command. */
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (ctx: any) => Promise<void> | void;
			},
		): void;

		/** Register a keyboard shortcut. */
		registerShortcut(
			shortcut: string,
			options: {
				description?: string;
				handler: (ctx: any) => Promise<void> | void;
			},
		): void;

		/** Subscribe to lifecycle events. */
		on(
			event: string,
			handler: (event: any, ctx: any) => Promise<any> | any,
		): void;
	}
}
