export {
	DEFAULT_MAX_OUTPUT_CHARS,
	DEFAULT_MAX_REDIRECTS,
	DEFAULT_MAX_RESPONSE_BYTES,
	DEFAULT_MAX_RETRIES,
	DEFAULT_WEBFETCH_BROWSER,
	DEFAULT_WEBFETCH_OS,
	DEFAULT_WEBFETCH_TIMEOUT_MS,
	fetch,
	fetchPage,
} from "./webfetch-api.ts";

export type {
	StaticWebFetchError,
	StaticWebFetchErrorCode,
	StaticWebFetchFailure,
	StaticWebFetchFormat,
	StaticWebFetchOptions,
	StaticWebFetchPhase,
	StaticWebFetchReplyPolicy,
	StaticWebFetchResult,
	StaticWebFetchSuccess,
} from "./webfetch-api.ts";

// The error model is the project-wide one (src/tools/fetch-error.ts), shared
// with the pi tools and the MCP server — re-exported so a consumer of this
// entrypoint can narrow on codes/phases/categories without a second import.
export type {
	FetchErrorCategory,
	FetchErrorCode,
	FetchPhase,
} from "./tools/fetch-error.ts";
