import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCodexHostAppDir, CODEXHOST_VERSION } from '../backend-builder.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appDir = findCodexHostAppDir({ explicitDir: process.argv[2], allowNpmLookup: true })

if (!appDir) {
  console.error(`Could not locate CodexHost ${CODEXHOST_VERSION} app directory (host-runtime.mjs).`)
  console.error(`Install @codexhost/cli-win32-x64@${CODEXHOST_VERSION} or pass its path: node scripts/setup-backend.mjs <path-to-app-dir>`)
  process.exit(1)
}

execFileSync(process.execPath, [path.join(root, 'build-backend.mjs'), appDir], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
