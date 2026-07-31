# Custom Vertical Extractors

pi-webaio ships 21 built-in site extractors (PyPI, npm, Hacker News, Reddit,
Context7, DeepWiki, …).
You can add your own extractors for company wikis, niche sites, or anything else
**without forking the package** — just drop `.mjs` files into a config directory.

---

## Security notice

Files in the config directory are loaded with Node.js `import()` and execute as
**arbitrary code with the full privileges of the pi-webaio agent process** — the
same user account, file-system access, network access, and environment variables.
Only place modules there that you wrote yourself or fully trust.

---

## Config directory

```
~/.pi/agent/webaio/verticals/
```

Create the directory if it does not exist:

```sh
mkdir -p ~/.pi/agent/webaio/verticals
```

Every `.mjs` file in that directory is loaded at startup. The directory is watched
only at load time (i.e. restart pi for changes to take effect).

You can override the directory for testing or CI by setting the environment variable:

```sh
PI_WEBAIO_USER_VERTICALS_DIR=/path/to/my/extractors pi ...
```

---

## Extractor contract

Each module must **default-export** (or **named-export** as `extractor`) an object
with the following shape:

```ts
interface UserExtractorModule {
  /** Short identifier shown in the "via <name>" attribution line. */
  name: string;

  /** Return true when this extractor should handle the given URL. */
  match(url: string): boolean;

  /**
   * Perform the extraction.
   * Return a VerticalResult on success, or null to signal "not handled"
   * (falls through to the built-in HTML pipeline).
   */
  extract(
    url: string,
    fetchJson: (url: string) => Promise<unknown | null>,
    fetchText: (url: string) => Promise<string | null>,
    fetchHtml: (url: string) => Promise<string | null>,
  ): Promise<VerticalResult | null>;
}

interface VerticalResult {
  ok: boolean;
  url: string;
  title?: string;
  content: string;   // Markdown string shown to the agent
  error?: string;    // Human-readable error message when ok === false
}
```

### Fetch helpers

The three helpers passed to `extract` are the same lightweight wrappers used by
all built-in extractors. They handle retries, timeouts, and the user's proxy
settings automatically:

| Helper | Returns |
| --- | --- |
| `fetchJson(url)` | Parsed JSON (`unknown`) or `null` on error / non-2xx |
| `fetchText(url)` | Raw response body as a string, or `null` on error |
| `fetchHtml(url)` | Raw HTML body as a string, or `null` on error |

---

## Priority

User extractors are checked **before** built-ins. If your extractor matches a URL
that a built-in also matches (e.g. `pypi.org`), your extractor wins.

If your extractor returns `null`, the built-in pipeline continues normally.
If your extractor **throws**, pi-webaio catches the error, emits a `[user-verticals]`
warning to stderr, and falls through to the built-in pipeline — startup is never
interrupted.

---

## Minimal example (copy-paste ready)

Save as `~/.pi/agent/webaio/verticals/my-wiki.mjs`:

```js
// ~/.pi/agent/webaio/verticals/my-wiki.mjs
// Extractor for Acme Corp internal wiki at wiki.acme.internal

export default {
  name: "acme-wiki",

  match(url) {
    return /^https?:\/\/wiki\.acme\.internal\//i.test(url);
  },

  async extract(url, fetchJson, fetchText, fetchHtml) {
    // Use the REST API exposed by your wiki software, or fetch HTML.
    const html = await fetchHtml(url);
    if (!html) return null;

    // Minimal extraction: pull the page title and first <article> block.
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "Wiki Page";

    const bodyMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const raw = bodyMatch ? bodyMatch[1] : html;

    // Strip tags for a plain-text approximation.
    const content = `# ${title}\n\n${raw.replace(/<[^>]+>/g, "").trim()}`;

    return { ok: true, url, title, content };
  },
};
```

### Using a JSON API instead

```js
export default {
  name: "acme-issues",

  match(url) {
    return url.startsWith("https://issues.acme.internal/issue/");
  },

  async extract(url, fetchJson) {
    const id = url.split("/issue/")[1];
    const data = await fetchJson(`https://issues.acme.internal/api/issue/${id}`);
    if (!data) return null;

    const content = [
      `# ${data.title}`,
      `**Status:** ${data.status}  **Reporter:** ${data.reporter}`,
      "",
      data.description ?? "_No description_",
    ].join("\n");

    return { ok: true, url, title: data.title, content };
  },
};
```

---

## Validation

At load time pi-webaio validates each module and **skips** any that fail, printing a
single warning to stderr like:

```
[user-verticals] Skipping /home/you/.pi/agent/webaio/verticals/broken.mjs: missing or empty string field "name"
```

Validation checks:

- `name` — non-empty string
- `match` — function, must not throw when called with `"https://example.com/"`
- `extract` — function
