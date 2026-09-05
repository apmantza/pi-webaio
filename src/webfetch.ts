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
	StaticWebFetchReplyPolicy,
	StaticWebFetchResult,
	StaticWebFetchSuccess,
} from "./webfetch-api.ts";
