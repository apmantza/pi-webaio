// Quick test script for the YouTube vertical extractor
import { extractYouTube, matchesYouTube } from "./src/verticals/youtube.js";

async function noop() {
	return null;
}

const testCases = [
	{
		label: "Standard watch URL",
		url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	},
	{ label: "youtu.be short URL", url: "https://youtu.be/dQw4w9WgXcQ" },
	{ label: "Shorts URL", url: "https://www.youtube.com/shorts/dQw4w9WgXcQ" },
	{ label: "Embed URL", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" },
];

console.log("=== Matcher tests ===");
for (const tc of testCases) {
	console.log(
		`  ${tc.label}: ${matchesYouTube(tc.url) ? "✅ match" : "❌ no match"}`,
	);
}
console.log(
	`  Non-YouTube:   ${matchesYouTube("https://example.com") ? "❌ false positive" : "✅ no match"}`,
);

console.log("\n=== Extraction test ===\n");

const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const result = await extractYouTube(url, noop, noop, noop);

if (!result) {
	console.log("❌ extractYouTube returned null");
	process.exit(1);
}

if (!result.ok) {
	console.log(`❌ Error: ${result.error}`);
	process.exit(1);
}

console.log(`Title:  ${result.title}`);
console.log(`URL:    ${result.url}`);
console.log(`Length: ${result.content.length} chars`);
console.log("\n--- Content (first 1000 chars) ---\n");
console.log(result.content.slice(0, 1000));
console.log("\n... [truncated]");
console.log(`\n--- Content (last 300 chars) ---\n`);
console.log(result.content.slice(-300));
