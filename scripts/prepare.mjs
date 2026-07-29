import { rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { dirname, join } from 'node:path';

// Resolve the tsc JS entry directly: node_modules/.bin/tsc is a shell shim on
// Windows, so it cannot be executed with node there.
//
// We resolve the always-exported `typescript/package.json` and join `bin/tsc`
// rather than resolving `typescript/bin/tsc` directly: typescript@7 added an
// `exports` map that does NOT expose the `./bin/tsc` subpath, so a direct
// resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED even when devDeps are present
// (the file still exists on disk; it is just not subpath-resolvable).
// Resolving `./package.json` works under both TS6 and TS7.
let tscPath;
try {
  const req = createRequire(import.meta.url);
  tscPath = join(dirname(req.resolve('typescript/package.json')), 'bin', 'tsc');
} catch (err) {
  // devDependencies not installed (e.g. npm install --omit=dev): typescript is
  // genuinely absent and dist ships pre-built. Only swallow the "not found"
  // case — any other resolution error must fail the build loudly rather than
  // silently skipping dist (which is how the TS7 exports breakage hid itself).
  if (err?.code === 'MODULE_NOT_FOUND' || err?.code === 'ERR_MODULE_NOT_FOUND') {
    process.exit(0);
  }
  throw err;
}

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, [tscPath, '--project', 'tsconfig.dist.json'], { stdio: 'inherit' });
