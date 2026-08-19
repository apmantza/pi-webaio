// ─── Paywall site strategy database ────────────────────────────────
// Curated subset of the Bypass Paywalls Clean (BPC) site catalog. We
// include the top 50 highest-traffic sites that are known to use
// paywalls, organized by newspaper group. Each entry is a small object
// describing which bypass strategies to try in order.
//
// Source: https://gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean
// (BPC's data/sites.js, MIT licensed).
//
// Update cadence: BPC publishes updates weekly. The strategies are
// stable across most news groups; vendor relationships rarely change.

// ─── Strategy types ────────────────────────────────────────────────
// Defined here (not in paywall.ts) so paywall-sites.ts has no import edge
// to paywall.ts: paywall.ts imports these from paywall-sites.ts instead,
// breaking the circular dependency (madge).

/** Which bypass strategy to try next. */
export type BypassStrategyType =
	| "ua:googlebot" // Spoof Googlebot UA — most common, ~85 sites
	| "ua:bingbot" // Spoof bingbot UA
	| "ua:facebookbot" // Spoof facebookexternalhit UA
	| "ua:custom" // Custom UA string per-site
	| "referer:google" // Google search referer header
	| "block_js" // Playwright with paywall JS blocked — ~425 sites
	| "archive" // Fetch from archive.org / archive.is — ~274 sites
	| "cookies" // Strip tracking cookies — ~138 sites
	| "archive_first" // Try archive before primary (cached versions)
	| "auto"; // Pick the cheapest strategy at runtime

/** A per-site bypass strategy: ordered steps plus optional tweaks. */
export interface PaywallStrategy {
	/** Ordered list of strategies to attempt. */
	steps: BypassStrategyType[];
	/** Patterns Playwright should abort (e.g. ["piano.io", "*.tinypass.com"]). */
	blockScripts?: string[];
	/** DOM CSS to apply after page load (hide paywall divs, set overflow). */
	domOverride?: boolean;
	/** Custom UA string (only for "ua:custom"). */
	useragentCustom?: string;
	/** Whether to allow cookies (false = send Cookie: header empty). */
	allowCookies?: boolean;
	/** Cookies to drop by name (tracking cookies). */
	dropCookies?: string[];
	/** Path → custom strategy override (e.g. subdomain rules). */
	overrides?: Record<string, Partial<PaywallStrategy>>;
}

// ─── Helper constructors ───────────────────────────────────────────

/** Block paywall JS in Playwright (most reliable for Piano/Tinypass). */
const blockJs = (vendors: string[]): PaywallStrategy => ({
	steps: ["block_js", "archive"],
	blockScripts: vendors,
	domOverride: true,
});

/** Try archive.org first, then JS block. */
const archiveFirst = (): PaywallStrategy => ({
	steps: ["archive", "block_js"],
	blockScripts: [
		"piano.io",
		"tinypass.com",
		"zephr.com",
		"poool.fr",
		"sophi.io",
	],
	domOverride: true,
});

/** Strip tracking cookies. */
const noCookies = (drop?: string[]): PaywallStrategy => ({
	steps: ["cookies", "ua:googlebot", "block_js"],
	dropCookies: drop,
	blockScripts: ["piano.io", "tinypass.com", "sophi.io"],
	domOverride: true,
});

// ─── Top-50 sites by traffic ───────────────────────────────────────

export const PAYWALL_SITES: Record<string, PaywallStrategy> = {
	// US — Tier 1
	"nytimes.com": blockJs(["piano.io", "*.tinypass.com", "*.nyt.com"]),
	"washingtonpost.com": blockJs(["piano.io", "*.washpost.com"]),
	"latimes.com": blockJs(["piano.io", "*.latimes.com"]),
	"chicagotribune.com": blockJs(["piano.io", "tribpub.com"]),
	"bostonglobe.com": blockJs(["piano.io", "*.bostonglobe.com"]),
	"sfchronicle.com": blockJs(["piano.io", "hearst.com"]),
	"dallasnews.com": blockJs(["piano.io"]),
	"inquirer.com": blockJs(["piano.io", "*.inquirer.com"]), // Philadelphia Inquirer
	"nypost.com": blockJs(["piano.io"]),
	"newsday.com": blockJs(["piano.io"]),
	"denverpost.com": blockJs(["piano.io"]),
	"mercurynews.com": blockJs(["piano.io"]), // San Jose Mercury News
	"oregonlive.com": blockJs(["sophi.io"]),
	"cleveland.com": blockJs(["sophi.io"]),
	"syracuse.com": blockJs(["sophi.io"]),
	"mlive.com": blockJs(["sophi.io"]),
	"masslive.com": blockJs(["sophi.io"]),
	"al.com": blockJs(["sophi.io"]),
	"nj.com": blockJs(["sophi.io"]),
	"lehighvalleylive.com": blockJs(["sophi.io"]),
	"silive.com": blockJs(["sophi.io"]),
	"pennlive.com": blockJs(["sophi.io"]),

	// US — Financial
	"wsj.com": blockJs(["piano.io", "*.wsj.com"]),
	"ft.com": blockJs(["piano.io", "spoor", "*.ft.com"]),
	"bloomberg.com": blockJs(["piano.io", "*.bloomberg.com"]),
	"economist.com": blockJs(["piano.io", "*.economist.com"]),
	"businessinsider.com": blockJs(["piano.io", "*.businessinsider.com"]),
	"forbes.com": blockJs(["piano.io", "*.forbes.com"]),
	"barrons.com": blockJs(["piano.io", "*.barrons.com"]),
	"marketwatch.com": blockJs(["piano.io"]),

	// US — Tech/Science
	"wired.com": blockJs(["piano.io", "*.wired.com"]),
	"theatlantic.com": blockJs(["piano.io", "*.theatlantic.com"]),
	"newyorker.com": blockJs(["piano.io", "*.newyorker.com"]),
	"vanityfair.com": blockJs(["piano.io", "*.vanityfair.com"]),
	"vogue.com": blockJs(["piano.io", "*.vogue.com"]),
	"natgeo.com": blockJs(["piano.io", "*.natgeo.com"]),
	"scientificamerican.com": blockJs(["piano.io", "*.scientificamerican.com"]),
	"technologyreview.com": blockJs(["piano.io", "*.technologyreview.com"]), // MIT Tech Review
	"arstechnica.com": blockJs(["piano.io", "*.arstechnica.com"]),
	"theverge.com": blockJs(["piano.io", "*.theverge.com"]),
	"politico.com": blockJs(["piano.io", "*.politico.com"]),
	"axios.com": blockJs(["piano.io", "*.axios.com"]),
	"thedailybeast.com": blockJs(["piano.io"]),

	// UK
	"thetimes.co.uk": blockJs(["piano.io", "*.thetimes.co.uk"]),
	"telegraph.co.uk": blockJs(["piano.io", "*.telegraph.co.uk"]),
	"thescotsman.com": blockJs(["piano.io"]),
	"theguardian.com": noCookies(), // Guardian uses a soft metered paywall
	"independent.co.uk": noCookies(),

	// EU — Germany
	"faz.net": blockJs(["piano.io", "*.faz.net"]),
	"sueddeutsche.de": blockJs(["piano.io", "*.sueddeutsche.de"]),
	"handelsblatt.com": blockJs(["piano.io", "*.handelsblatt.com"]),
	"welt.de": blockJs(["piano.io", "*.welt.de"]),
	"spiegel.de": blockJs(["piano.io", "*.spiegel.de"]),
	"zeit.de": blockJs(["piano.io", "*.zeit.de"]),

	// EU — France
	"lemonde.fr": blockJs(["poool.fr", "*.lemonde.fr"]),
	"lefigaro.fr": blockJs(["poool.fr", "*.lefigaro.fr"]),
	"lesechos.fr": blockJs(["poool.fr", "*.lesechos.fr"]),
	"liberation.fr": blockJs(["poool.fr", "*.liberation.fr"]),

	// EU — Italy
	"corriere.it": blockJs(["piano.io", "*.corriere.it"]),
	"repubblica.it": blockJs(["piano.io", "*.repubblica.it"]),
	"lastampa.it": blockJs(["piano.io", "*.lastampa.it"]),

	// EU — Spain
	"elpais.es": blockJs(["piano.io", "*.elpais.es"]),
	"elmundo.es": blockJs(["piano.io", "*.elmundo.es"]),
	"lavanguardia.com": blockJs(["piano.io", "*.lavanguardia.com"]),

	// EU — Netherlands
	"ad.nl": blockJs(["temptation", "*.ad.nl"]),
	"volkskrant.nl": blockJs(["temptation", "*.volkskrant.nl"]),
	"trouw.nl": blockJs(["temptation", "*.trouw.nl"]),
	"parool.nl": blockJs(["temptation", "*.parool.nl"]),
	"nrc.nl": blockJs(["piano.io", "*.nrc.nl"]),
	"fd.nl": blockJs(["piano.io", "*.fd.nl"]), // Het Financieele Dagblad

	// Australia
	"smh.com.au": blockJs(["piano.io", "*.smh.com.au"]),
	"theage.com.au": blockJs(["piano.io", "*.theage.com.au"]),
	"theaustralian.com.au": blockJs(["piano.io", "*.theaustralian.com.au"]),
	"brisbanetimes.com.au": blockJs(["piano.io", "*.brisbanetimes.com.au"]),
	"watoday.com.au": blockJs(["piano.io", "*.watoday.com.au"]),
	"canberratimes.com.au": blockJs(["piano.io"]),

	// Canada
	"theglobeandmail.com": blockJs(["piano.io"]),
	"nationalpost.com": blockJs(["piano.io"]),
	"thestar.com": blockJs(["piano.io"]),
	"montrealgazette.com": blockJs(["piano.io"]),

	// Asia / Other
	"scmp.com": blockJs(["piano.io", "*.scmp.com"]), // South China Morning Post
	"japantimes.co.jp": blockJs(["piano.io"]),
	"koreaherald.com": blockJs(["piano.io"]),
	"straitstimes.com": blockJs(["piano.io"]),
	"bangkokpost.com": blockJs(["piano.io"]),
	"timesofindia.indiatimes.com": blockJs(["piano.io"]),
	"thehindu.com": blockJs(["piano.io"]),

	// Misc
	"reuters.com": archiveFirst(), // Reuters rarely paywalls, archive is reliable
	"ap.org": archiveFirst(),
	"theintercept.com": blockJs(["piano.io"]),
	"thenation.com": blockJs(["piano.io"]),
	"newrepublic.com": blockJs(["piano.io"]),
	"harpers.org": blockJs(["piano.io"]),
	"thedriftmag.com": blockJs(["piano.io"]),
	"lrb.co.uk": blockJs(["piano.io"]), // London Review of Books
	"nybooks.com": blockJs(["piano.io"]), // NY Review of Books
	"tabletmag.com": blockJs(["piano.io"]),

	// Other regions / smaller sites
	"nzherald.co.nz": blockJs(["piano.io"]),
	"thejournal.ie": noCookies(),
	"irishtimes.com": blockJs(["piano.io"]),
};

// ─── Group strategies (apply to many domains sharing the same owner) ─

/**
 * Newspaper chains / holding companies that share a single paywall
 * vendor across all their regional sites. Checked by suffix after a
 * direct hostname miss.
 */
export const PAYWALL_GROUPS: Record<string, PaywallStrategy> = {
	// Advance Local (US regional) — Sophi.io
	"advancelocal.com": blockJs(["sophi.io", "*.sophi.io"]),

	// Gannett (US regional) — various Piano deployments
	"gannett-cdn.com": blockJs(["piano.io", "tinypass.com"]),
	"gannettdigital.com": blockJs(["piano.io", "tinypass.com"]),

	// Lee Enterprises (US regional) — Piano
	"lee.net": blockJs(["piano.io"]),

	// Tribune Publishing — Piano + Tribune CDN
	"tribpub.com": blockJs(["piano.io", "*.tribpub.com"]),

	// Hearst Newspapers — Piano
	"hearst.com": blockJs(["piano.io", "*.hearst.com"]),
	"hearstnp.com": blockJs(["piano.io", "*.hearstnp.com"]),

	// DPG Media (Netherlands/Belgium) — Temptation
	"dpgmedia.be": blockJs(["temptation", "*.dpgmedia.be"]),
	"dpgmedia.nl": blockJs(["temptation", "*.dpgmedia.nl"]),

	// Axel Springer (DE) — Piano
	"axelspringer.com": blockJs(["piano.io", "*.axelspringer.com"]),

	// Schibsted (Nordic) — Piano
	"schibsted.com": blockJs(["piano.io", "*.schibsted.com"]),

	// News Corp Australia — Piano
	"newscorpaustralia.com": blockJs(["piano.io", "*.newscorpaustralia.com"]),

	// Condé Nast (Vogue, Vanity Fair, New Yorker, Wired) — Piano
	"condenastdigital.com": blockJs(["piano.io", "*.condenast.com"]),

	// Emerson Collective (The Atlantic) — Piano
	"emersoncollective.com": blockJs(["piano.io", "*.emersoncollective.com"]),

	// Vox Media (The Verge, Vox, SB Nation) — Piano
	"vox-cdn.com": blockJs(["piano.io", "*.vox-cdn.com"]),

	// The Times / News UK — Piano
	"news.co.uk": blockJs(["piano.io", "*.news.co.uk"]),
	"newsuk.com": blockJs(["piano.io", "*.newsuk.com"]),

	// Politico / Axel Springer — Piano
	"politico.com": blockJs(["piano.io", "*.politico.com"]),
};

/**
 * Number of sites in the catalog. Useful for status messages.
 */
export const PAYWALL_SITE_COUNT =
	Object.keys(PAYWALL_SITES).length + Object.keys(PAYWALL_GROUPS).length;
