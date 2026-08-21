/**
 * Ambient type declaration for @earendil-works/pi-tui (#108).
 *
 * pi-tui is a pi-bundled core package: pi resolves the bare specifier from
 * its own runtime, so pi-webaio declares it as an OPTIONAL peer plus a
 * devDependency and never as a runtime dependency (a runtime dependency
 * would make `npm install --omit=dev` -- the command pi runs for a `git:`
 * install -- vendor a private second copy).
 *
 * `npm install --omit=dev` also omits devDependencies, so the production
 * build (`scripts/prepare.mjs`, which runs `tsc --project
 * tsconfig.dist.json` with full type-checking, unlike pi-lens's
 * `--noCheck` bundle build) cannot see pi-tui's real .d.ts files in that
 * environment. This ambient declaration is the fallback: it supplies the
 * subset of the API `src/tools/render-result.ts` and
 * `src/tools/websearch.ts` use, so `tsc` resolves the module whether or
 * not the real package is installed. When the real package IS present
 * (local dev, CI's `Unit tests` / `Lint & type-check` jobs, which install
 * devDependencies), this is a no-op safety net -- same pattern as
 * `types/pi-coding-agent.d.ts` for the other host-provided peer.
 *
 * Deliberately NOT a module itself (no top-level import/export): a
 * `declare module "x"` block inside a file that has import/export of its
 * own only AUGMENTS an already-resolvable module x, so it does nothing
 * when the real package is absent -- which is exactly the --omit=dev
 * case this file exists for. As a global script, this block instead
 * DEFINES the ambient module outright when nothing else resolves it.
 */

declare module "@earendil-works/pi-tui" {
	/** Common shape returned by every widget's `render`/`invalidate` pair. */
	export interface Component {
		render(width: number): string[];
		invalidate(): void;
	}

	export class Text implements Component {
		constructor(text: string, x?: number, y?: number);
		setText(text: string): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export class Container implements Component {
		constructor();
		addChild(child: Component): void;
		render(width: number): string[];
		invalidate(): void;
	}

	export class Spacer implements Component {
		constructor(lines?: number);
		render(width: number): string[];
		invalidate(): void;
	}

	export interface MarkdownTheme {
		[key: string]: unknown;
	}

	export class Markdown implements Component {
		constructor(
			content: string,
			x?: number,
			y?: number,
			theme?: MarkdownTheme,
		);
		render(width: number): string[];
		invalidate(): void;
	}

	export function truncateToWidth(text: string, width: number): string;
	export function visibleWidth(text: string): number;
}
