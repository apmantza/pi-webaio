/**
 * Optional pi-tui bridge.
 *
 * pi-webaio's MCP server and non-pi consumers do not necessarily install the
 * host-provided pi-tui peer. Tool execution does not need TUI widgets, so keep
 * this import optional and provide tiny component-shaped fallbacks for callers
 * that ask a non-pi runtime to render a result anyway.
 */
import type { MarkdownTheme as PiMarkdownTheme } from "@earendil-works/pi-tui";

export type MarkdownTheme = PiMarkdownTheme;

type Renderable = {
	render(width: number): string[];
	invalidate(): void;
};

type TextLike = Renderable & {
	setText(text: string): void;
};

class FallbackText implements TextLike {
	private value: string;

	constructor(text = "") {
		this.value = text;
	}

	setText(text: string): void {
		this.value = text;
	}

	render(width: number): string[] {
		if (width <= 0) return [""];
		return this.value
			.split("\n")
			.map((line) =>
				line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line,
			);
	}

	invalidate(): void {}
}

class FallbackSpacer implements Renderable {
	private readonly height: number;

	constructor(height = 1) {
		this.height = Math.max(0, height);
	}

	render(_width: number): string[] {
		return Array.from({ length: this.height }, () => "");
	}

	invalidate(): void {}
}

class FallbackContainer implements Renderable {
	private readonly children: Renderable[] = [];

	addChild(child: Renderable): void {
		this.children.push(child);
	}

	render(width: number): string[] {
		return this.children.flatMap((child) => child.render(width));
	}

	invalidate(): void {
		for (const child of this.children) child.invalidate();
	}
}

const tui = await import("@earendil-works/pi-tui").catch(() => undefined);

export const Text = (tui?.Text ?? FallbackText) as new (
	text?: string,
	paddingX?: number,
	paddingY?: number,
) => TextLike;

export const Spacer = (tui?.Spacer ?? FallbackSpacer) as new (
	height?: number,
) => Renderable;

export const Container = (tui?.Container ?? FallbackContainer) as new () => {
	addChild(child: Renderable): void;
	render(width: number): string[];
	invalidate(): void;
};

export const Markdown = (tui?.Markdown ?? FallbackText) as new (
	text?: string,
	paddingX?: number,
	paddingY?: number,
	theme?: MarkdownTheme,
) => Renderable;
