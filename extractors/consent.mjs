import { randomInt } from "node:crypto";

// consent.mjs — auto-dismiss common cookie/consent banners and human-verification pages
// Call dismissConsent(tab, cdp) after navigating to any page.
//
// Covers major CMPs: OneTrust, Cookiebot, Didomi, Quantcast, Usercentrics,
// TrustArc, Klaro, Sourcepoint, CookieYes, Osano, CookieFirst, Adobe,
// SmartNews, CookieHub, TermsFeed, Google, YouTube, BBC, Amazon — plus
// generic text-based fallbacks and iframe consent dialogs.

// ─── Cookie consent dismissal JS (evaluated in the target page) ─────

const CONSENT_JS = `
(function() {
  var clicked = [];

  var isVisible = function(el) {
    if (!el) return false;
    var style = getComputedStyle(el);
    return style.display !== 'none' &&
           style.visibility !== 'hidden' &&
           style.opacity !== '0' &&
           (el.offsetParent !== null || style.position === 'fixed' || style.position === 'sticky');
  };

  var tryClick = function(selector, description) {
    var el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (isVisible(el)) {
      el.click();
      clicked.push(description || selector);
      return true;
    }
    return false;
  };

  var findButtonByText = function(patterns, container) {
    container = container || document;
    var buttons = Array.from(container.querySelectorAll('button, [role="button"], a.button, input[type="submit"], input[type="button"]'));
    var sortedPatterns = [...patterns].sort(function(a, b) { return b.length - a.length; });
    for (var i = 0; i < sortedPatterns.length; i++) {
      for (var j = 0; j < buttons.length; j++) {
        var btn = buttons[j];
        var text = (btn.textContent || btn.value || '').trim().toLowerCase();
        if (text.length > 100) continue;
        if (!isVisible(btn)) continue;
        var pattern = sortedPatterns[i];
        if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
          return btn;
        }
      }
    }
    return null;
  };

  var acceptPatterns = [
    'accept all', 'accept cookies', 'allow all', 'allow cookies',
    'i agree', 'i accept', 'yes, i agree', 'agree and continue',
    'alle akzeptieren', 'akzeptieren', 'alle zulassen', 'zustimmen',
    'annehmen', 'einverstanden',
    'accepter tout', 'tout accepter', "j'accepte", 'accepter et continuer', 'accepter',
    'accetta tutti', 'accetta', 'accetto',
    'aceptar todo', 'aceptar', 'acepto',
    'aceitar tudo', 'aceitar',
    'continue', 'agree',
  ];

  var rejectPatterns = [
    'reject all', 'decline all', 'deny all', 'refuse all',
    'i do not agree', 'i disagree', 'no thanks',
    'alle ablehnen', 'ablehnen', 'nicht zustimmen',
    'refuser tout', 'tout refuser', 'refuser',
    'rifiuta tutti', 'rifiuta',
    'rechazar todo', 'rechazar',
    'rejeitar tudo', 'rejeitar',
    'only necessary', 'necessary only', 'nur notwendige',
    'essential only', 'nur essentielle',
  ];

  // ── OneTrust ──
  if (document.querySelector('#onetrust-banner-sdk, #onetrust-consent-sdk')) {
    if (tryClick('#onetrust-accept-btn-handler, .onetrust-accept-btn-handler', 'OneTrust')) return clicked;
  }

  // ── Google consent ──
  if (document.querySelector('[data-consent-dialog]') || document.querySelector('form[action*="consent.google"]') || document.querySelector('#CXQnmb')) {
    if (tryClick('#L2AGLb, button[jsname="b3VHJd"], .tHlp8d', 'Google Consent')) return clicked;
  }

  // ── YouTube (Google-owned, custom consent element) ──
  if (document.querySelector('ytd-consent-bump-v2-lightbox')) {
    var ytBtns = Array.from(document.querySelectorAll('ytd-consent-bump-v2-lightbox button'));
    var ytBtn = ytBtns.find(function(b) {
      return b.textContent.includes('Accept all') || b.textContent.includes('Reject all') ||
             (b.getAttribute('aria-label') || '').includes('Accept') || (b.getAttribute('aria-label') || '').includes('Reject');
    });
    if (ytBtn) { ytBtn.click(); clicked.push('YouTube'); return clicked; }
  }

  // ── Cookiebot ──
  if (document.querySelector('#CybotCookiebotDialog')) {
    if (tryClick('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll, #CybotCookiebotDialogBodyButtonDecline', 'Cookiebot')) return clicked;
  }

  // ── Didomi ──
  if (document.querySelector('#didomi-host') || document.querySelector('.didomi-notice') || (window && window.Didomi)) {
    if (tryClick('#didomi-notice-agree-button, [data-testid="disagree-button"]', 'Didomi')) return clicked;
  }

  // ── Quantcast ──
  if (document.querySelector('.qc-cmp2-container') || document.querySelector('.qc-cmp2-ui-root')) {
    if (tryClick('.qc-cmp2-summary-buttons button[mode="primary"], .qc-cmp2-button[data-testid="accept-all"], .qc-cmp2-summary-buttons button[mode="secondary"]', 'Quantcast')) return clicked;
  }

  // ── Usercentrics (shadow DOM) ──
  var ucRoot = document.querySelector('#usercentrics-root');
  if (ucRoot && ucRoot.shadowRoot) {
    var shadow = ucRoot.shadowRoot;
    var ucBtn = shadow.querySelector('[data-testid="uc-accept-all-button"], [data-testid="uc-deny-all-button"]');
    if (ucBtn) { ucBtn.click(); clicked.push('Usercentrics'); return clicked; }
  }

  // ── TrustArc ──
  if (document.querySelector('#truste-consent-track') || document.querySelector('#truste-consent-modal') || document.querySelector('.trustarc-banner')) {
    if (tryClick('#truste-consent-button, .trustarc-agree-btn, .trustarc-decline-btn', 'TrustArc')) return clicked;
  }

  // ── Klaro ──
  if (document.querySelector('.klaro')) {
    if (tryClick('.klaro .cm-btn-accept-all, .klaro .cm-btn-success, .klaro .cm-btn-decline', 'Klaro')) return clicked;
  }

  // ── Sourcepoint ──
  if (document.querySelector('#sp-root') || document.querySelector('#sp-frame-root') || document.querySelector('.sp-root')) {
    var spBtn = document.querySelector('[title="Accept All"], [title="Accept"], [aria-label*="Accept"]');
    if (tryClick(spBtn, 'Sourcepoint')) return clicked;
  }

  // ── BBC ──
  if (document.querySelector('#bbccookies, .bbccookies-banner')) {
    if (tryClick('#bbccookies-continue-button', 'BBC')) return clicked;
  }

  // ── Amazon ──
  if (document.querySelector('#sp-cc') || document.querySelector('#sp-cc-accept')) {
    if (tryClick('#sp-cc-accept, #sp-cc-rejectall-link, #sp-cc-decline', 'Amazon')) return clicked;
  }

  // ── CookieYes / Borzy ──
  if (document.querySelector('#cookie-law-info-bar') || document.querySelector('.cky-consent-container')) {
    if (tryClick('#cookie_action_close_header, .cky-btn-accept, .cky-btn-reject', 'CookieYes')) return clicked;
  }

  // ── Osano ──
  if (document.querySelector('#osano-cm-dialog') || document.querySelector('#osano-cm-window')) {
    if (tryClick('[data-osano-type="accept-all"], [data-osano-type="accept-necessary"], [data-osano-type="reject-all"]', 'Osano')) return clicked;
  }

  // ── CookieFirst ──
  if (document.querySelector('#cookie-first')) {
    if (tryClick('#cookie-first-accept-all, #cookie-first-reject-all', 'CookieFirst')) return clicked;
  }

  // ── Adobe Privacy Message Center ──
  if (document.querySelector('#adobe-privacy-message-center')) {
    if (tryClick('#adobe-privacy-message-center [class*="Accept"], #adobe-privacy-message-center [class*="Reject"]', 'Adobe PMC')) return clicked;
  }

  // ── SmartNews / SmartConsent ──
  if (document.querySelector('#smartconsent-modal') || document.querySelector('#smartconsent-root')) {
    if (tryClick('#smartconsent-accept-all, #smartconsent-reject-all', 'SmartConsent')) return clicked;
  }

  // ── CookieHub ──
  if (document.querySelector('#chv-banner') || document.querySelector('#chv-module')) {
    if (tryClick('#chv-accept, #chv-reject', 'CookieHub')) return clicked;
  }

  // ── TermsFeed ──
  if (document.querySelector('#tc-warning')) {
    if (tryClick('#tc-accept, .tc-btn-accept', 'TermsFeed')) return clicked;
  }

  // ── Generic containers (class/id heuristics) ──
  var consentContainers = [
    '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookie-notice"]',
    '[class*="cookieBar"]', '[class*="cookieConsent"]', '[class*="CookieBanner"]',
    '[class*="CookieConsent"]', '[class*="CookieNotice"]',
    '[id*="cookie-banner"]', '[id*="cookie-consent"]', '[id*="cookie-notice"]',
    '[id*="cookieBar"]', '[id*="CookieBanner"]', '[id*="CookieConsent"]',
    '[class*="consent-banner"]', '[class*="consent-modal"]', '[class*="consent-dialog"]',
    '[class*="consentBar"]', '[class*="ConsentBanner"]', '[class*="ConsentModal"]',
    '[id*="consent-banner"]', '[id*="consent-dialog"]', '[id*="consent-modal"]',
    '[class*="gdpr-banner"]', '[class*="gdpr-consent"]', '[class*="GdprBanner"]',
    '[id*="gdpr-banner"]',
    '[class*="privacy-banner"]', '[class*="privacy-notice"]', '[class*="PrivacyBanner"]',
  ];

  for (var c = 0; c < consentContainers.length; c++) {
    var containers = document.querySelectorAll(consentContainers[c]);
    for (var k = 0; k < containers.length; k++) {
      var container = containers[k];
      if (!isVisible(container)) continue;
      if (container.tagName === 'HTML' || container.tagName === 'BODY') continue;
      var btn = findButtonByText(acceptPatterns, container);
      if (btn) { btn.click(); clicked.push('Generic (' + consentContainers[c] + ')'); return clicked; }
    }
  }

  // ── Text-based fallback: look for containers mentioning "cookie" with accept buttons ──
  var allContainers = document.querySelectorAll('div, section, aside, [class*="modal"], [class*="dialog"], [role="dialog"]');
  for (var a = 0; a < allContainers.length; a++) {
    var el = allContainers[a];
    if (!isVisible(el)) continue;
    var bodyText = (el.textContent || '').toLowerCase();
    if (bodyText.includes('cookie') && bodyText.length > 100 && bodyText.length < 3000) {
      var genericBtn = findButtonByText(acceptPatterns, el);
      if (genericBtn && isVisible(genericBtn)) {
        genericBtn.click();
        clicked.push('Generic (text-based)');
        return clicked;
      }
    }
  }

  // ── Last resort: any visible button with accept text on a cookie page ──
  if ((document.body.textContent || '').toLowerCase().includes('cookie')) {
    var exactPatterns = ['accept all', 'accept cookies', 'allow all', 'i agree', 'alle akzeptieren'];
    var allBtns = document.querySelectorAll('button, [role="button"]');
    for (var b = 0; b < allBtns.length; b++) {
      var button = allBtns[b];
      if (!isVisible(button)) continue;
      var btnText = (button.textContent || '').trim().toLowerCase();
      for (var p = 0; p < exactPatterns.length; p++) {
        if (btnText.includes(exactPatterns[p])) {
          button.click();
          clicked.push('Generic (exact match)');
          return clicked;
        }
      }
    }
  }

  return clicked;
})();
`;

// ─── Human verification detection (unchanged from original) ─────────

const VERIFY_DETECT_JS = `
(function() {
  var url = document.location.href;

  // --- Google "sorry" page (hard CAPTCHA, can't auto-solve) ---
  if (url.includes('/sorry/') || url.includes('sorry.google')) return 'sorry-page';

  // --- Microsoft account verification page ---
  function hostMatches(u, h) { try { var p = new URL(u); return p.hostname === h || p.hostname.endsWith('.' + h); } catch(e) { return false; } }
  if (hostMatches(url, 'login.microsoftonline.com') || hostMatches(url, 'login.live.com') || hostMatches(url, 'account.microsoft.com')) {
    var msBtns = Array.from(document.querySelectorAll('button, input[type=submit], a'));
    var msVerify = msBtns.find(b => /verify|continue|next/i.test(b.innerText?.trim() || b.value || ''));
    if (msVerify) { msVerify.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:msVerify.innerText?.trim()||msVerify.value}); }
  }

  // --- Copilot / modal verification ---
  var modal = document.querySelector('[role="dialog"], .b_modal, [class*="verify"], [class*="challenge"]');
  if (modal) {
    var modalBtns = Array.from(modal.querySelectorAll('button, a[role="button"], input[type="submit"]'));
    var actionBtn = modalBtns.find(b => /^(continue|verify|submit|next|i agree|accept|got it)$/i.test(b.innerText?.trim() || b.value || ''));
    if (actionBtn) { actionBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:actionBtn.innerText?.trim()}); }
  }

  // --- Turnstile / Cloudflare challenge iframe (return coordinates for humanClickXY) ---
  var turnstileIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge"]');
  if (turnstileIframe) {
    var r = turnstileIframe.getBoundingClientRect();
    return JSON.stringify({t:'xy',x:r.left+30,y:r.top+r.height/2});
  }

  // --- Cloudflare challenge page ---
  var cfCheckbox = document.querySelector('#cf-stage input[type="checkbox"], .ctp-checkbox-container input');
  if (cfCheckbox) { cfCheckbox.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:'cloudflare-checkbox'}); }
  var cfBtn = document.querySelector('#challenge-form button, .cf-challenge button');
  if (cfBtn) { cfBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:cfBtn.innerText?.trim()}); }

  // --- Microsoft "I am human" button ---
  var msHumanBtn = document.querySelector('button[id*="i0"], button[id*="id__"]');
  if (msHumanBtn && /verify|human|robot|continue/i.test(msHumanBtn.innerText?.trim())) {
    msHumanBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:msHumanBtn.innerText.trim()});
  }

  // --- Generic verify/continue/proceed buttons (catch-all) ---
  var btns = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'));
  var verify = btns.find(b => {
    var t = (b.innerText?.trim() || b.value || '').toLowerCase();
    return (t.includes('verify') || t.includes('human') || t.includes('robot') || t.includes('continue') || t.includes('proceed')) &&
           !t.includes('verified') && !document.querySelector('iframe[src*="recaptcha"]');
  });
  if (verify) { verify.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:verify.innerText?.trim()||verify.value}); }

  // --- Google reCAPTCHA checkbox ---
  var recaptchaCheckbox = document.querySelector('.recaptcha-checkbox-unchecked, input[type=checkbox][id*="recaptcha"]');
  if (recaptchaCheckbox) { recaptchaCheckbox.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:'recaptcha'}); }

  return null;
})()
`;

const VERIFY_RETRY_JS = `
(function() {
  var url = document.location.href;
  function hostMatches(u, h) { try { var p = new URL(u); return p.hostname === h || p.hostname.endsWith('.' + h); } catch(e) { return false; } }
  var isVerifyPage = url.includes('/sorry/') ||
                     hostMatches(url, 'challenges.cloudflare.com') ||
                     hostMatches(url, 'login.microsoftonline.com') ||
                     document.querySelector('#challenge-running, #challenge-stage, .cf-turnstile, [role="dialog"]');
  if (!isVerifyPage) return 'cleared';

  var btns = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'));
  var btn = btns.find(b => {
    var t = (b.innerText?.trim() || b.value || '').toLowerCase();
    return t.includes('verify') || t.includes('human') || t.includes('robot') || t.includes('continue') || t.includes('next') || t.includes('submit');
  });
  if (btn) { btn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:btn.innerText?.trim()||btn.value}); }

  var cf = document.querySelector('#cf-stage input[type="checkbox"], .cf-turnstile input');
  if (cf) { cf.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:'turnstile'}); }

  var modal = document.querySelector('[role="dialog"], .b_modal, [class*="verify"]');
  if (modal) {
    var modalBtn = modal.querySelector('button, a[role="button"]');
    if (modalBtn) { modalBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:modalBtn.innerText?.trim()}); }
  }

  return 'still-verifying';
})()
`;

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Attempt to dismiss cookie consent banners in the main page.
 * Returns an array of CMP names that were dismissed, or empty array if none found.
 *
 * Covers: OneTrust, Cookiebot, Didomi, Quantcast, Usercentrics (shadow DOM),
 * TrustArc, Klaro, Sourcepoint, CookieYes, Osano, CookieFirst, Adobe PMC,
 * SmartConsent, CookieHub, TermsFeed, Google, YouTube, BBC, Amazon — plus
 * generic text-based fallbacks.
 */
export async function dismissConsent(tab, cdp) {
	const result = await cdp(["eval", tab, CONSENT_JS]).catch(() => null);

	if (result && result !== "null") {
		try {
			const dismissed = JSON.parse(result);
			if (Array.isArray(dismissed) && dismissed.length > 0) {
				process.stderr.write(
					`[consent] Dismissed cookie dialog: ${dismissed.join(", ")}\n`,
				);
				await new Promise((r) => setTimeout(r, 1500));
				return dismissed;
			}
		} catch {
			// Legacy string result (e.g., "google", "onetrust")
			if (typeof result === "string" && result.length > 0) {
				process.stderr.write(`[consent] Dismissed cookie dialog: ${result}\n`);
				await new Promise((r) => setTimeout(r, 1500));
				return [result];
			}
		}
	}

	return [];
}

// ─── Human-like click simulation (multi-event with jitter) ────────────

function rng(min, max) {
	// crypto.randomInt is used instead of Math.random() to comply with SonarCloud security hotspot S2245.
	// This is NOT security-sensitive — the random values are only used for mouse-jitter and timing delays.
	return randomInt(min * 1000, max * 1000) / 1000;
}

/**
 * Perform a human-like click at specific coordinates via CDP Input.dispatchMouseEvent.
 * Sends: mouseMoved → randomPause → mousePressed → randomPause → mouseReleased
 * with coordinate jitter and variable timing to mimic human motor variance.
 */
export async function humanClickXY(tab, cdpFn, x, y) {
	const cx = Number.parseFloat(x);
	const cy = Number.parseFloat(y);
	if (Number.isNaN(cx) || Number.isNaN(cy)) {
		throw new Error(`humanClickXY: invalid coordinates (${x}, ${y})`);
	}

	const base = { button: "left", clickCount: 1, modifiers: 0 };

	// ── mouseMoved with slight jitter ──
	const jx = cx + rng(-3, 3);
	const jy = cy + rng(-3, 3);
	await cdpFn([
		"evalraw",
		tab,
		"Input.dispatchMouseEvent",
		JSON.stringify({ ...base, type: "mouseMoved", x: jx, y: jy }),
	]);
	await new Promise((r) => setTimeout(r, rng(80, 180)));

	// ── mousePressed at jittered position ──
	const px = cx + rng(-2, 2);
	const py = cy + rng(-2, 2);
	await cdpFn([
		"evalraw",
		tab,
		"Input.dispatchMouseEvent",
		JSON.stringify({ ...base, type: "mousePressed", x: px, y: py }),
	]);
	await new Promise((r) => setTimeout(r, rng(30, 90)));

	// ── mouseReleased at jittered position ──
	const rx = px + rng(-1, 1);
	const ry = py + rng(-1, 1);
	await cdpFn([
		"evalraw",
		tab,
		"Input.dispatchMouseEvent",
		JSON.stringify({ ...base, type: "mouseReleased", x: rx, y: ry }),
	]);
	await new Promise((r) => setTimeout(r, rng(100, 300)));

	return `human-clicked at (${cx.toFixed(0)}, ${cy.toFixed(0)})`;
}

/**
 * Find an element by CSS selector and perform a human-like click on its center.
 */
export async function humanClickElement(tab, cdpFn, selector) {
	const rect = await cdpFn([
		"eval",
		tab,
		`(function() {
			var el = document.querySelector('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');
			if (!el) return 'null';
			var r = el.getBoundingClientRect();
			return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height});
		})()`,
	]).catch(() => "null");

	if (!rect || rect === "null") {
		return null;
	}

	const { x, y } = JSON.parse(rect);
	return humanClickXY(tab, cdpFn, x, y);
}

/**
 * Parse a detection result and perform a human click if it found something.
 * Returns true if a click was performed.
 */
async function tryHumanClick(tab, cdp, detectResult) {
	if (
		!detectResult ||
		detectResult === "null" ||
		detectResult === "cleared" ||
		detectResult === "still-verifying"
	)
		return false;

	try {
		const info = JSON.parse(detectResult);
		if (info.t === "sel" && info.s) {
			process.stderr.write(
				`[greedysearch] Human-clicking "${info.txt}" via CDP...\n`,
			);
			const r = await humanClickElement(tab, cdp, info.s);
			return r !== null;
		}
		if (info.t === "xy") {
			process.stderr.write(
				`[greedysearch] Human-clicking at (${info.x.toFixed(0)}, ${info.y.toFixed(0)})...\n`,
			);
			await humanClickXY(tab, cdp, info.x, info.y);
			return true;
		}
	} catch {}

	return false;
}

// ─── Human verification handling (unchanged from original) ─────────────

/**
 * Detect and handle human verification challenges (CAPTCHA, Cloudflare, etc.).
 * Returns 'clear' | 'clicked' | 'needs-human' | 'cleared-by-user'
 */
export async function handleVerification(tab, cdp, waitMs = 30000) {
	const result = await cdp(["eval", tab, VERIFY_DETECT_JS]).catch(() => null);

	if (!result || result === "null") return "clear";

	if (result === "sorry-page") {
		process.stderr.write(
			`[greedysearch] Google CAPTCHA detected — please solve it in the browser window (waiting up to ${Math.floor(waitMs / 1000)}s)...\n`,
		);
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2000));
			const url = await cdp(["eval", tab, "document.location.href"]).catch(
				() => "",
			);
			if (!url.includes("/sorry/")) return "cleared-by-user";
		}
		return "needs-human";
	}

	const clicked = await tryHumanClick(tab, cdp, result);
	if (clicked) {
		await new Promise((r) => setTimeout(r, 2000));

		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			const retryResult = await cdp(["eval", tab, VERIFY_RETRY_JS]).catch(
				() => null,
			);
			if (retryResult === "cleared" || !retryResult || retryResult === "null") {
				process.stderr.write("[greedysearch] Verification cleared.\n");
				return "clicked";
			}
			if (retryResult !== "still-verifying") {
				await tryHumanClick(tab, cdp, retryResult);
				await new Promise((r) => setTimeout(r, 2000));
			} else {
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		process.stderr.write(
			"[greedysearch] Verification may require manual intervention.\n",
		);
		return "needs-human";
	}

	return "clear";
}
