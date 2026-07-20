import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadContentCacheFromDisk,
	loadSearchCacheFromDisk,
	cleanupSessionCache,
	SESSION_CACHE_CLEANUP_MS,
} from "./src/session-store.ts";
import { initUserExtractors } from "./src/verticals/registry.ts";
import { registerWebfetchTool } from "./src/tools/webfetch.ts";
import { registerWebcontentTool } from "./src/tools/webcontent.ts";
import { registerWebresultTool } from "./src/tools/webresult.ts";
import { registerWebsearchTool } from "./src/tools/websearch.ts";
import { registerWebmapTool } from "./src/tools/webmap.ts";
import { registerWebpullTool } from "./src/tools/webpull.ts";
import { registerWebqueryTool } from "./src/tools/webquery.ts";
import { registerWebresearchTool } from "./src/tools/webresearch.ts";

export default function (pi: ExtensionAPI) {
	// Load user-defined vertical extractors from ~/.pi/agent/webaio/verticals/
	initUserExtractors().catch(() => {});

	// Load persisted search cache on startup
	loadSearchCacheFromDisk().catch(() => {});
	// Load persisted content cache from disk (lazy — contents loaded on first access)
	loadContentCacheFromDisk();

	// Start session cache cleanup.
	// .unref() so this recurring timer does not keep the Node.js event loop
	// alive on its own. Without it, one-shot `pi -p` invocations never exit:
	// the agent finishes and prints its answer, but the process hangs until
	// killed because the ref'd interval keeps the loop running.
	setInterval(cleanupSessionCache, SESSION_CACHE_CLEANUP_MS).unref();

	// Register all 8 tools
	registerWebfetchTool(pi);
	registerWebcontentTool(pi);
	registerWebresultTool(pi);
	registerWebsearchTool(pi);
	registerWebmapTool(pi);
	registerWebpullTool(pi);
	registerWebqueryTool(pi);
	registerWebresearchTool(pi);
}
