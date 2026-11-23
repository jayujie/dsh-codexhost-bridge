import { readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testDir = path.join(root, 'test')
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.test.mjs'))
  .filter(f => !readFileSync(path.join(testDir, f), 'utf8').includes('backend/'))
  .map(f => path.join(testDir, f))

console.log(`Running ${files.length} backend-free unit test files...`)
execFileSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
