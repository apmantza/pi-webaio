// ─── Interactive element extraction ──────────────────────────────────
// Extracts actionable elements (buttons, links, inputs, selects, forms)
// from HTML and assigns stable numbered refs.  Inspired by Retio-pagemap's
// interactable detection, but operating on raw HTML via linkedom.

import { parseHTML } from "linkedom";

export interface InteractableElement {
	/** Stable reference number (1-based, per-page) */
	ref: number;
	/** Element role: button, link, input, select, textarea, form */
	role: string;
	/** Human-readable name (text content, aria-label, placeholder, value) */
	name: string;
	/** Interaction type: click, type, select, submit */
	affordance: string;
	/** Current value (for inputs/selects) */
	value?: string;
	/** Available options (for selects) */
	options?: string[];
	/** Source of the name (text, aria-label, placeholder, title, alt) */
	nameSource?: string;
	/** XPath-like location for debugging */
	path?: string;
}

/**
 * Build a short XPath-like path for an element (for debugging).
 */
function buildPath(el: Element): string {
	const parts: string[] = [];
	let current: Element | null = el;
	while (current && current !== current.ownerDocument?.documentElement) {
		const tag = current.tagName.toLowerCase();
		const parent: Element | null = current.parentElement;
		if (parent) {
			const siblings = [...parent.children].filter(
				(c) => c.tagName === current!.tagName,
			);
			const idx = siblings.indexOf(current) + 1;
			parts.unshift(siblings.length > 1 ? `${tag}[${idx}]` : tag);
		} else {
			parts.unshift(tag);
		}
		current = parent;
	}
	return "/" + parts.join("/");
}

/**
 * Extract a human-readable name for an interactive element.
 * Priority: aria-label > text content > placeholder > title > alt > value.
 */
function extractName(el: Element): { name: string; source: string } {
	const ariaLabel = el.getAttribute("aria-label")?.trim();
	if (ariaLabel) return { name: ariaLabel, source: "aria-label" };

	// For inputs, prefer placeholder over text content
	const tag = el.tagName.toLowerCase();
	if (tag === "input") {
		const placeholder = el.getAttribute("placeholder")?.trim();
		if (placeholder) return { name: placeholder, source: "placeholder" };
		const value =
			(el as any).value?.trim?.() || el.getAttribute("value")?.trim();
		if (value) return { name: value, source: "value" };
	}

	// Text content (first 100 chars)
	const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
	if (text) return { name: text, source: "text" };

	// Fallbacks
	const title = el.getAttribute("title")?.trim();
	if (title) return { name: title, source: "title" };

	const alt = el.getAttribute("alt")?.trim();
	if (alt) return { name: alt, source: "alt" };

	return { name: `[${tag}]`, source: "tag" };
}

/**
 * Determine the affordance (interaction type) for an element.
 */
function getAffordance(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const type = el.getAttribute("type")?.toLowerCase() || "";

	if (tag === "select") return "select";
	if (tag === "textarea") return "type";
	if (tag === "input") {
		if (type === "submit" || type === "button" || type === "reset")
			return "click";
		if (type === "checkbox" || type === "radio") return "click";
		if (type === "file") return "click";
		return "type"; // text, email, password, search, etc.
	}
	if (tag === "button") return "click";
	if (tag === "a" && el.getAttribute("href")) return "click";
	if (tag === "form") return "submit";
	return "click"; // default
}

/**
 * Check if an element is likely visible and interactive (not hidden, not disabled).
 */
function isInteractive(el: Element): boolean {
	const tag = el.tagName.toLowerCase();

	// Check disabled state
	if (el.hasAttribute("disabled")) return false;
	if (el.getAttribute("aria-disabled") === "true") return false;

	// Check hidden state
	if (el.hasAttribute("hidden")) return false;
	if (el.getAttribute("aria-hidden") === "true") return false;

	// Check type=hidden
	if (tag === "input" && el.getAttribute("type")?.toLowerCase() === "hidden")
		return false;

	// Skip elements inside nav/footer (usually not the main action targets)
	let parent: Element | null = el.parentElement;
	while (parent) {
		const pTag = parent.tagName.toLowerCase();
		if (pTag === "nav" || pTag === "footer") return false;
		if (pTag === "body" || pTag === "main" || pTag === "article") break;
		parent = parent.parentElement;
	}

	return true;
}

/**
 * Get select options.
 */
function getSelectOptions(el: Element): string[] {
	const options: string[] = [];
	el.querySelectorAll("option").forEach((opt) => {
		const text = (opt.textContent || "").trim();
		const value = opt.getAttribute("value");
		if (text || value) {
			options.push(value || text);
		}
	});
	return options;
}

/**
 * Get the role string for an element.
 */
function getRole(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const type = el.getAttribute("type")?.toLowerCase() || "";
	const explicitRole = el.getAttribute("role");

	if (explicitRole) return explicitRole;

	if (tag === "a") return "link";
	if (tag === "button") return "button";
	if (tag === "select") return "select";
	if (tag === "textarea") return "textbox";
	if (tag === "input") {
		if (type === "submit") return "button";
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "search") return "searchbox";
		return "textbox";
	}
	if (tag === "form") return "form";
	return tag;
}

/** Max elements to extract (to prevent huge lists). */
const MAX_ELEMENTS = 50;

/**
 * Extract all interactive elements from HTML string.
 * Returns an array of InteractableElement with stable 1-based ref numbers.
 */
export function extractInteractables(html: string): InteractableElement[] {
	const { document } = parseHTML(html);
	const elements: InteractableElement[] = [];

	// Selector for all interactive elements
	const selector = [
		"a[href]",
		"button:not([type='hidden'])",
		"input:not([type='hidden'])",
		"select",
		"textarea",
		"form",
		'[role="button"]',
		'[role="link"]',
		'[role="textbox"]',
		'[role="searchbox"]',
		'[role="combobox"]',
		'[role="checkbox"]',
		'[role="radio"]',
		"[onclick]",
	].join(",");

	const seen = new Set<string>(); // dedup by name+role+affordance
	let ref = 0;

	document.querySelectorAll(selector).forEach((el) => {
		if (ref >= MAX_ELEMENTS) return;
		if (!isInteractive(el)) return;

		const { name, source } = extractName(el);
		const role = getRole(el);
		const affordance = getAffordance(el);

		// Dedup: skip duplicate name+role+affordance combos
		const key = `${role}|${name}|${affordance}`;
		if (seen.has(key)) return;
		seen.add(key);

		ref++;
		const entry: InteractableElement = {
			ref,
			role,
			name,
			affordance,
			nameSource: source,
			path: buildPath(el),
		};

		// Value for inputs
		const tag = el.tagName.toLowerCase();
		if (tag === "input" || tag === "textarea") {
			const val =
				(el as any).value?.trim?.() || el.getAttribute("value")?.trim();
			if (val) entry.value = val;
		}

		// Options for selects
		if (tag === "select") {
			const opts = getSelectOptions(el);
			if (opts.length) entry.options = opts;
		}

		elements.push(entry);
	});

	return elements;
}

/**
 * Format interactables as a PageMap-style agent prompt section.
 */
export function formatInteractablesSection(
	elements: InteractableElement[],
): string {
	if (!elements.length) return "";

	const lines: string[] = ["## Actions"];
	for (const el of elements) {
		let line = `[${el.ref}] ${el.role}: ${el.name} (${el.affordance})`;
		if (el.value) line += ` value="${el.value}"`;
		if (el.options && el.options.length) {
			const opts = el.options.slice(0, 8).join(",");
			const extra = el.options.length > 8 ? `...+${el.options.length - 8}` : "";
			line += ` options=[${opts}${extra}]`;
		}
		lines.push(line);
	}
	lines.push("");
	return lines.join("\n");
}
