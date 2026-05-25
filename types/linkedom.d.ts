declare module "linkedom" {
	export function parseHTML(html: string): {
		document: Document;
		window: Window;
		[key: string]: unknown;
	};
}
