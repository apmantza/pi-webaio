declare module "playwright" {
	export const chromium: {
		launch(opts?: {
			channel?: "chrome" | "msedge";
			headless?: boolean;
		}): Promise<Browser>;
	};
	interface Browser {
		newPage(): Promise<Page>;
		close(): Promise<void>;
	}
	interface Page {
		goto(
			url: string,
			opts?: { waitUntil?: string; timeout?: number },
		): Promise<void>;
		content(): Promise<string>;
	}
}
