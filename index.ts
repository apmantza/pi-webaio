import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadContentCacheFromDisk,
	loadSearchCacheFromDisk,
	cleanupSessionCache,
	SESSION_CACHE_CLEANUP_MS,
} from "./src/session-store.ts";
import { registerWebfetchTool } from "./src/tools/webfetch.ts";
import { registerWebcontentTool } from "./src/tools/webcontent.ts";
import { registerWebresultTool } from "./src/tools/webresult.ts";
import { registerWebsearchTool } from "./src/tools/websearch.ts";
import { registerWebmapTool } from "./src/tools/webmap.ts";
import { registerWebpullTool } from "./src/tools/webpull.ts";

export default function (pi: ExtensionAPI) {
	// Load persisted search cache on startup
	loadSearchCacheFromDisk().catch(() => {});
	// Load persisted content cache from disk (lazy — contents loaded on first access)
	loadContentCacheFromDisk();

	// Start session cache cleanup
	setInterval(cleanupSessionCache, SESSION_CACHE_CLEANUP_MS);

	// Register all 6 tools
	registerWebfetchTool(pi);
	registerWebcontentTool(pi);
	registerWebresultTool(pi);
	registerWebsearchTool(pi);
	registerWebmapTool(pi);
	registerWebpullTool(pi);
}
