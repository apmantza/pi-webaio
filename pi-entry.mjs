// pi extension entry.
//
// npm installs ship compiled dist/ (built by prepare at publish time), which
// pi loads directly with no transpile cost. git installs have no dist/ at all:
// pi installs packages with `npm install --omit=dev`, so typescript is absent
// and prepare skips the build. In that case fall back to the TypeScript
// source, which pi (or Node >= 22.18 via native type stripping) loads directly.
let mod;
try {
	mod = await import("./dist/index.js");
} catch (err) {
	if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
	mod = await import("./index.ts");
}
export default mod.default;
