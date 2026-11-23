import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function findCodexHostAppDir() {
  const candidates = [process.argv[2], process.env.CODEXHOST_APP_DIR].filter(Boolean)
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@codexhost', 'cli-win32-x64', 'app'))
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@codexhost', 'cli', 'app'))
  }
  try {
    const npmRoot = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' }).trim()
    if (npmRoot) {
      candidates.push(path.join(npmRoot, '@codexhost', 'cli-win32-x64', 'app'))
      candidates.push(path.join(npmRoot, '@codexhost', 'cli', 'app'))
    }
  } catch {}
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, 'host-runtime.mjs'))) return dir
  }
  return null
}

const appDir = findCodexHostAppDir()
if (!appDir) {
  console.error('Could not locate CodexHost 0.17.4 app directory (host-runtime.mjs).')
  console.error('Install @codexhost/cli or pass its path: node scripts/setup-backend.mjs <path-to-app-dir>')
  process.exit(1)
}

execFileSync(process.execPath, [path.join(root, 'build-backend.mjs'), appDir], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
