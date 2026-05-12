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

console.log("\n=== Extraction tests ===\n");

// Test 1: Standard video
console.log("--- Test 1: Standard video (Rick Astley) ---");
const r1 = await extractYouTube(
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	noop,
	noop,
	noop,
);
if (!r1?.ok) {
	console.log(`❌ Failed: ${r1?.error ?? "null"}`);
} else {
	console.log(`✅ Title: ${r1.title}`);
	console.log(`   Length: ${r1.content.length} chars`);
}

// Test 2: youtu.be URL
console.log("\n--- Test 2: youtu.be URL (Rick Astley) ---");
const r2 = await extractYouTube(
	"https://youtu.be/dQw4w9WgXcQ",
	noop,
	noop,
	noop,
);
if (!r2?.ok) {
	console.log(`❌ Failed: ${r2?.error ?? "null"}`);
} else {
	console.log(`✅ Title: ${r2.title}`);
	console.log(`   Length: ${r2.content.length} chars`);
}

// Test 3: Invalid video
console.log("\n--- Test 3: Invalid video ID ---");
const r3 = await extractYouTube(
	"https://www.youtube.com/watch?v=invalidvideoid1",
	noop,
	noop,
	noop,
);
if (!r3?.ok) {
	console.log(`✅ Expected error: ${r3.error?.slice(0, 80)}...`);
} else {
	console.log(`❌ Should have failed`);
}

// Test 4: Segments format
console.log("\n--- Test 4: Segments format (Rick Astley) ---");
const r4 = await extractYouTube(
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	noop,
	noop,
	noop,
	{ format: "segments" },
);
if (!r4?.ok) {
	console.log(`❌ Failed: ${r4?.error ?? "null"}`);
} else {
	console.log(`✅ Title: ${r4.title}`);
	console.log(`   Length: ${r4.content.length} chars`);
	// Show first 3 lines of transcript
	const transcriptLines = r4.content
		.split("## Transcript\n\n")[1]
		?.split("\n")
		.slice(0, 5);
	console.log(`   First 5 lines:`);
	for (const line of transcriptLines) {
		console.log(`     ${line}`);
	}
}

// Test 5: VTT format
console.log("\n--- Test 5: VTT format (Rick Astley) ---");
const r5 = await extractYouTube(
	"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	noop,
	noop,
	noop,
	{ format: "vtt" },
);
if (!r5?.ok) {
	console.log(`❌ Failed: ${r5?.error ?? "null"}`);
} else {
	console.log(`✅ Title: ${r5.title}`);
	console.log(`   Length: ${r5.content.length} chars`);
	const vttLines = r5.content
		.split("## Transcript\n\n")[1]
		?.split("\n")
		.slice(0, 8);
	console.log(`   First 8 lines:`);
	for (const line of vttLines) {
		console.log(`     ${line}`);
	}
}
