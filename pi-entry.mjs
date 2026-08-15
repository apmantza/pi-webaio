// pi extension entry.
//
// npm installs ship compiled dist/ (built by prepare at publish time).
// git installs ALSO get dist/: pi installs packages with `npm install
// --omit=dev` (typescript absent), so prepare fetches the pinned compiler
// transiently via npx (typescript@7.0.2) and builds dist from source — same
// production-install strategy as pi-free. The .ts fallback below is only a
// safety net for unbuilt source checkouts / dev clones (Node >= 22.18
// native type stripping).
let mod;
try {
	mod = await import("./dist/index.js");
} catch (err) {
	if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
	mod = await import("./index.ts");
}
export default mod.default;
