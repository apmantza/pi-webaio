import { existsSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

const tscBin = join('node_modules', '.bin', 'tsc');
if (!existsSync(tscBin)) {
  // devDependencies not installed (e.g. npm install --omit=dev); dist is pre-built
  process.exit(0);
}

rmSync('dist', { recursive: true, force: true });
execFileSync(process.execPath, [tscBin, '--project', 'tsconfig.dist.json'], { stdio: 'inherit' });
