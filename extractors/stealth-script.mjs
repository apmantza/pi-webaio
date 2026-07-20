// extractors/stealth-script.mjs — single source of truth for the hardened
// anti-detection stealth script.
//
// Ported from greedysearch-pi's `extractors/common.mjs` (`injectHeadlessStealth`),
// MIT licensed, same author. That version is validated: Sannysoft 20/20 clean,
// identical CreepJS fingerprints headless vs visible (see its docs/analysis.md).
//
// This module exports the raw script source as a plain string so it can be
// injected verbatim by either consumer without any build step:
//   - extractors/common.mjs — via CDP `Page.addScriptToEvaluateOnNewDocument`
//   - src/fetch.ts           — via Playwright `page.addInitScript` (dynamic
//                              import at runtime; see src/stealth-loader.ts)
//
// Keeping this in a plain .mjs file (rather than under src/) means it ships
// as-is (no TypeScript compilation) and is reachable at a stable path from
// both the source tree and the compiled dist/ tree.

export const STEALTH_SCRIPT = `
(function() {
  // ── Runtime.enable / CDP detection masking ──────────────
  try { delete window.__REBROWSER_RUNTIME_ENABLE; } catch(_) {}
  try { delete window.__REBROWSER_DEVTOOLS; } catch(_) {}
  try { delete window.__nightmare; } catch(_) {}
  try { delete window.__phantom; } catch(_) {}
  try { delete window.callPhantom; } catch(_) {}
  try { delete window._phantom; } catch(_) {}
  try { delete window.Buffer; } catch(_) {}

  // Real Chrome without automation should not expose navigator.webdriver at all.
  // A literal false or an own-property getter returning undefined is itself a
  // common stealth tell; remove both instance and prototype properties when the
  // descriptor is configurable (as it is with --disable-blink-features).
  try { delete navigator.webdriver; } catch(_) {}
  try { delete Navigator.prototype.webdriver; } catch(_) {}
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
  Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });
  Object.defineProperty(navigator, 'productSub', { get: () => '20030107', configurable: true });
  Object.defineProperty(navigator, 'product', { get: () => 'Gecko', configurable: true });
  var __greedyMimeTypes = null;
  function __makeMimeTypes() {
    var pdf = { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null };
    var textPdf = { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null };
    try { Object.setPrototypeOf(pdf, MimeType.prototype); } catch(_) {}
    try { Object.setPrototypeOf(textPdf, MimeType.prototype); } catch(_) {}
    var m = [pdf, textPdf];
    try { Object.setPrototypeOf(m, MimeTypeArray.prototype); } catch(_) {}
    m.item = function item(i) { return this[i] || null; };
    m.namedItem = function namedItem(name) { return Array.prototype.find.call(this, function(x) { return x && x.type === name; }) || null; };
    return m;
  }
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      __greedyMimeTypes = __greedyMimeTypes || __makeMimeTypes();
      var plugin0 = { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' };
      var plugin1 = { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' };
      var plugin2 = { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' };
      try { Object.setPrototypeOf(plugin0, Plugin.prototype); } catch(_) {}
      try { Object.setPrototypeOf(plugin1, Plugin.prototype); } catch(_) {}
      try { Object.setPrototypeOf(plugin2, Plugin.prototype); } catch(_) {}
      var p = [plugin0, plugin1, plugin2];
      p.item = function item(i) { return this[i] || null; };
      p.namedItem = function namedItem(name) { return Array.prototype.find.call(this, function(x) { return x && x.name === name; }) || null; };
      p.refresh = function refresh() {};
      try { Object.setPrototypeOf(p, PluginArray.prototype); } catch(_) {}
      try {
        __greedyMimeTypes[0].enabledPlugin = p[0];
        __greedyMimeTypes[1].enabledPlugin = p[0];
      } catch(_) {}
      return p;
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      __greedyMimeTypes = __greedyMimeTypes || __makeMimeTypes();
      return __greedyMimeTypes;
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  try {
    Object.defineProperty(navigator, 'connection', { get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, downlinkMax: Infinity, saveData: false }), configurable: true });
  } catch(_) {}
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      get: () => ({
        enumerateDevices: () => Promise.resolve([
          { deviceId: 'default', kind: 'audioinput', label: '', groupId: 'default' },
          { deviceId: 'default', kind: 'audiooutput', label: '', groupId: 'default' },
          { deviceId: '', kind: 'videoinput', label: '', groupId: '' },
        ]),
        getUserMedia: () => Promise.reject(new DOMException('NotAllowedError')),
        getDisplayMedia: () => Promise.reject(new DOMException('NotAllowedError')),
      }),
      configurable: true,
    });
  }
  // ── Missing platform APIs (headless often lacks these) ─
  try {
    if (!navigator.share) {
      navigator.share = function() { return Promise.reject(new Error('NotAllowedError')); };
    }
  } catch(_) {}
  try {
    if (!navigator.contentIndex) {
      Object.defineProperty(navigator, 'contentIndex', { get: () => ({ add: function() {}, delete: function() {}, getAll: function() { return Promise.resolve([]); } }), configurable: true });
    }
  } catch(_) {}

  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      runtime: {
        OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {},
        connect: () => ({}), sendMessage: () => {}, onMessage: { addListener: () => {} }
      },
      loadTimes: function() { return { requestTime: 0, startLoadTime: Date.now() - 5000, commitLoadTime: Date.now() - 3000, finishDocumentLoadTime: Date.now() - 2000, finishLoadTime: Date.now() - 1000, firstPaintTime: Date.now() - 800, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'http/2' }; },
      csi: function() { var t = Date.now(); return { onloadT: t - 2000, startE: t - 5000, pageT: 'back', tran: 2 }; },
    };
  }
  var __greedyNativeFns = [];
  function __markNative(fn) { try { __greedyNativeFns.push(fn); } catch(_) {} return fn; }

  var origQuery = navigator.permissions?.query;
  if (origQuery) {
    navigator.permissions.query = __markNative(function query(params) {
      if (params && params.name === 'notifications') return Promise.resolve({ state: Notification.permission || 'default', onchange: null });
      return origQuery.apply(this, arguments);
    });
  }
  try {
    var getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = __markNative(function getParameter(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    });
  } catch(_) {}
  // ── WebGL readPixels noise ──────────────────────────
  // CreepJS and other fingerprinters draw content with WebGL and read back the
  // rendered pixels. Adding subtle noise breaks rendering-based fingerprinting.
  try {
    var origReadPixels = WebGLRenderingContext.prototype.readPixels;
    WebGLRenderingContext.prototype.readPixels = __markNative(function readPixels(x, y, width, height, format, type, pixels) {
      var result = origReadPixels.call(this, x, y, width, height, format, type, pixels);
      if (pixels && pixels.length > 0) {
        pixels[0] ^= 1;
      }
      return result;
    });
  } catch(_) {}
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

  // ── Canvas fingerprint noise ─────────────────────────
  // Headless rendering engines produce slightly different canvas output
  // than headed Chrome. Subtle noise breaks hash-based fingerprinting.
  try {
    var __canvasNoise = ((Date.now() & 0xFF) | 1);
    var origFill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = __markNative(function fillText() {
      this.globalAlpha = 0.9995;
      return origFill.apply(this, arguments);
    });
  } catch(_) {}
  try {
    var origStroke = CanvasRenderingContext2D.prototype.strokeText;
    CanvasRenderingContext2D.prototype.strokeText = __markNative(function strokeText() {
      this.globalAlpha = 0.9995;
      return origStroke.apply(this, arguments);
    });
  } catch(_) {}
  try {
    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = __markNative(function toDataURL() {
      var ctx = this.getContext('2d');
      if (ctx) {
        // Spread noise across canvas to break hash-based fingerprinting.
        // Uses a deterministic pattern so it's consistent per page load
        // but varies between sessions.
        var w = this.width, h = this.height;
        if (w > 0 && h > 0) {
          var imgData = ctx.getImageData(0, 0, Math.min(w, 4), Math.min(h, 4));
          if (imgData && imgData.data) {
            for (var __i = 0; __i < imgData.data.length; __i += 4) {
              imgData.data[__i] ^= (__canvasNoise + __i) & 0xFF;
            }
            ctx.putImageData(imgData, 0, 0);
          }
        }
      }
      return origToDataURL.apply(this, arguments);
    });
  } catch(_) {}

  // ── AudioContext fingerprint noise ────────────────────
  // Headless Chrome's AudioContext produces slightly different output.
  // Subtle noise breaks audio-based fingerprinting.
  try {
    var __audioSeed = ((Date.now() & 0x1F) | 1);
    var origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = __markNative(function getChannelData(channel) {
      var data = origGetChannelData.call(this, channel);
      for (var __i = 0; __i < data.length; __i += 64) {
        data[__i] *= 0.99999;
      }
      return data;
    });
  } catch(_) {}

  // ── window outer dimensions ──────────────────────────
  // outerWidth/Height = 0 in headless — a well-known bot signal.
  // Mirror innerWidth/Height (set by --window-size flag) so the ratio is sane.
  try {
    if (!window.outerWidth)  Object.defineProperty(window, 'outerWidth',  { get: () => window.innerWidth  || 1920, configurable: true });
    if (!window.outerHeight) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight || 1080, configurable: true });
  } catch(_) {}

  // ── screen properties ─────────────────────────────────
  // Headless Chrome often reports an 800x600 screen even when the viewport is
  // 1920x1080. Keep screen metrics internally consistent with our launch flags.
  try {
    Object.defineProperty(screen, 'width', { get: () => 1920, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => 1080, configurable: true });
    Object.defineProperty(screen, 'availWidth', { get: () => 1920, configurable: true });
    Object.defineProperty(screen, 'availHeight', { get: () => 1040, configurable: true });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
  } catch(_) {}

  // ── navigator.userAgentData (UA Client Hints) ─────────
  // Derive version from the UA string already set by --user-agent flag so the
  // two APIs are always consistent. Removes any "HeadlessChrome" brand entry.
  try {
    var _uaMajor = (navigator.userAgent.match(new RegExp('Chrome/([0-9]+)')) || [])[1] || '136';
    var _uaFull  = (navigator.userAgent.match(new RegExp('Chrome/([0-9.]+)')) || [])[1] || (_uaMajor + '.0.0.0');
    var _brands  = [
      { brand: 'Not)A;Brand',  version: '99' },
      { brand: 'Google Chrome', version: _uaMajor },
      { brand: 'Chromium',      version: _uaMajor },
    ];
    Object.defineProperty(navigator, 'userAgentData', {
      get: function() {
        return {
          brands: _brands, mobile: false, platform: 'Windows',
          getHighEntropyValues: function() {
            return Promise.resolve({
              architecture: 'x86', bitness: '64',
              brands: _brands,
              fullVersionList: [
                { brand: 'Not)A;Brand',   version: '99.0.0.0' },
                { brand: 'Google Chrome', version: _uaFull },
                { brand: 'Chromium',      version: _uaFull },
              ],
              mobile: false, model: '', platform: 'Windows',
              platformVersion: '15.0.0', uaFullVersion: _uaFull, wow64: false,
            });
          },
          toJSON: function() { return { brands: _brands, mobile: false, platform: 'Windows' }; },
        };
      },
      configurable: true,
    });
  } catch(_) {}

  // ── CDP Runtime serialization guard ──────────────────
  // Sites detect CDP by putting a getter on Error.prototype.stack
  // and checking if console.log triggers it (only happens when
  // Runtime domain is enabled). We monkey-patch console methods to
  // strip custom getters from arguments before they reach CDP.
  try {
    var _origLog = console.log, _origError = console.error,
        _origWarn = console.warn, _origDebug = console.debug,
        _origInfo = console.info;
    var _safeArg = function(a) {
      if (a instanceof Error) {
        try { return new Error(a.message); } catch(_) { return a; }
      }
      return a;
    };
    console.log = __markNative(function log() { return _origLog.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.error = __markNative(function error() { return _origError.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.warn = __markNative(function warn() { return _origWarn.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.debug = __markNative(function debug() { return _origDebug.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.info = __markNative(function info() { return _origInfo.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
  } catch(_) {}

  // ── Native function masking ──────────────────────────
  // Patched APIs should not stringify as user-defined stealth code.
  try {
    var __nativeToString = Function.prototype.toString;
    Function.prototype.toString = function toString() {
      if (__greedyNativeFns.indexOf(this) !== -1) {
        var name = this.name || '';
        return 'function ' + name + '() { [native code] }';
      }
      return __nativeToString.call(this);
    };
  } catch(_) {}
})();
`;
