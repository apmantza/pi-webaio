// ─── YouTube extractor ──────────────────────────────────────────────
// Uses youtube-transcript-plus (Innertube API) for transcripts + metadata.
// No API key required. Supports videos, shorts, and playlist URLs.

import type { VerticalResult } from "./types.ts";
import {
	fetchTranscript,
	toPlainText,
	toVTT,
	type TranscriptResult,
} from "youtube-transcript-plus";

// ─── URL parsing ────────────────────────────────────────────────────

const VIDEO_ID_REGEX =
	/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const BARE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_REGEX = /list=([A-Za-z0-9_-]+)/;

/**
 * Extract a YouTube video ID from various URL formats.
 */
function extractVideoId(url: string): string | null {
	const s = url.trim();
	if (BARE_ID_REGEX.test(s)) return s;
	const m = s.match(VIDEO_ID_REGEX);
	return m ? m[1]! : null;
}

/**
 * Extract a playlist ID from a URL.
 */
function extractPlaylistId(url: string): string | null {
	const m = url.match(PLAYLIST_REGEX);
	return m ? m[1]! : null;
}

/**
 * Format seconds as HH:MM:SS.
 */
function formatDuration(seconds: number | null | undefined): string {
	if (!seconds) return "unknown";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0)
		return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Format a number with commas (e.g. 1,234,567).
 */
function formatNumber(n: number | null | undefined): string {
	if (n == null) return "unknown";
	return n.toLocaleString();
}

// ─── Matching ───────────────────────────────────────────────────────

export function matchesYouTube(url: string): boolean {
	return (
		/youtube\.com\/(?:watch\?|shorts\/|embed\/)|youtu\.be\//i.test(url) ||
		BARE_ID_REGEX.test(url)
	);
}

// ─── Extraction ─────────────────────────────────────────────────────

interface YouTubeFetchOpts {
	/** Preferred language code (e.g. "en"). Defaults to first available. */
	language?: string;
	/** Output format: "text", "vtt", or "segments". Defaults to "text". */
	format?: "text" | "vtt" | "segments";
	/** Include video metadata block. Defaults to true. */
	metadata?: boolean;
	/** Max transcript length in characters. Defaults to 40,000 (~10K tokens). */
	maxLength?: number;
}

/**
 * Fetch video metadata + transcript in one call via Innertube API.
 */
async function fetchVideoData(
	videoId: string,
	language?: string,
): Promise<TranscriptResult | null> {
	try {
		return (await fetchTranscript(videoId, {
			lang: language,
			videoDetails: true,
		})) as TranscriptResult;
	} catch {
		return null;
	}
}

/**
 * Extract YouTube video content (transcript + metadata).
 */
export async function extractYouTube(
	url: string,
	_fetchJson: (url: string) => Promise<unknown | null>,
	_fetchText: (url: string) => Promise<string | null>,
	_fetchHtml: (url: string) => Promise<string | null>,
	opts?: YouTubeFetchOpts,
): Promise<VerticalResult | null> {
	const videoId = extractVideoId(url);
	if (!videoId) return null;

	const lang = opts?.language;
	const format = opts?.format ?? "text";
	const includeMetadata = opts?.metadata ?? true;
	const maxLength = opts?.maxLength ?? 40000;

	// Fetch metadata + transcript in one call
	let data = await fetchVideoData(videoId, lang);

	// Retry without language constraint if that fails
	if (!data) {
		data = await fetchVideoData(videoId);
	}

	if (!data) {
		return {
			ok: false,
			url,
			error: `Failed to fetch transcript for video ${videoId}. The video may be unavailable, age-restricted, or have transcripts disabled.`,
			content: "",
		};
	}

	const vd = data.videoDetails;
	const segments = data.segments;
	const transcriptLang = segments[0]?.lang ?? lang ?? "unknown";

	let transcriptText: string;
	switch (format) {
		case "vtt":
			transcriptText = toVTT(segments);
			break;
		case "segments":
			transcriptText = segments
				.map(
					(s: { offset: number; text: string }) =>
						`[${formatDuration(s.offset)}] ${s.text}`,
				)
				.join("\n");
			break;
		default:
			transcriptText = toPlainText(segments, " ");
	}

	// Truncate if too long
	if (transcriptText.length > maxLength) {
		transcriptText =
			transcriptText.slice(0, maxLength) +
			"\n\n... [transcript truncated, " +
			transcriptText.length +
			" total chars]";
	}

	// Build markdown
	let md = "";

	if (includeMetadata) {
		md += `# ${vd.title}\n\n`;
		md += `- **Channel:** ${vd.author}\n`;
		if (vd.channelId) md += `- **Channel ID:** ${vd.channelId}\n`;
		md += `- **Duration:** ${formatDuration(vd.lengthSeconds)}\n`;
		md += `- **Views:** ${formatNumber(vd.viewCount)}\n`;
		md += `- **Language:** ${transcriptLang}\n`;
		if (vd.isLiveContent) md += `- **Type:** Live\n`;
		if (vd.keywords?.length)
			md += `- **Tags:** ${vd.keywords.slice(0, 10).join(", ")}\n`;
		if (vd.description) {
			const desc =
				vd.description.length > 600
					? vd.description.slice(0, 600) + "…"
					: vd.description;
			md += `\n## Description\n\n${desc}\n`;
		}
		md += "\n";
	}

	md += "## Transcript\n\n";
	md += transcriptText;

	return {
		ok: true,
		url,
		title: vd.title,
		content: md,
	};
}

// ─── Playlist extraction (placeholder — future enhancement) ─────────

function matchesYouTubePlaylist(url: string): boolean {
	return /youtube\.com\/(?:playlist|watch\?.*list=)/i.test(url);
}

async function extractYouTubePlaylist(
	url: string,
	_fetchJson: (url: string) => Promise<unknown | null>,
	_fetchText: (url: string) => Promise<string | null>,
	_fetchHtml: (url: string) => Promise<string | null>,
): Promise<VerticalResult | null> {
	const playlistId = extractPlaylistId(url);
	if (!playlistId) return null;

	return {
		ok: false,
		url,
		error: `YouTube playlist support is not yet available. Please fetch individual video URLs from playlist https://www.youtube.com/playlist?list=${playlistId}.`,
		content: "",
	};
}
