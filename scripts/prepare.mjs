import { rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

// Resolve the tsc JS entry directly: node_modules/.bin/tsc is a shell shim on
// Windows, so it cannot be executed with node there.
let tscPath;
try {
  tscPath = createRequire(import.meta.url).resolve('typescript/bin/tsc');
} catch {
  // devDependencies not installed (e.g. npm install --omit=dev); dist is pre-built
  process.exit(0);
}

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, [tscPath, '--project', 'tsconfig.dist.json'], { stdio: 'inherit' });
