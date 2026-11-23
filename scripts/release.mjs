import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSemver, compareSemver } from '../plugin-updater.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const noPush = args.includes('--no-push')
const bumpArg = args.find(arg => !arg.startsWith('--'))

if (!bumpArg) {
  console.error('Usage: npm run release -- <patch|minor|major|x.y.z> [--no-push]')
  process.exit(1)
}

const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (status) {
  console.error('Working tree is not clean. Commit or stash pending changes before releasing.')
  process.exit(1)
}

const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
const current = parseSemver(pkg.version)
if (!current) throw new Error(`Invalid current version: ${pkg.version}`)

let nextVersion
if (bumpArg === 'patch') nextVersion = `${current.major}.${current.minor}.${current.patch + 1}`
else if (bumpArg === 'minor') nextVersion = `${current.major}.${current.minor + 1}.0`
else if (bumpArg === 'major') nextVersion = `${current.major + 1}.0.0`
else if (parseSemver(bumpArg)) nextVersion = bumpArg.replace(/^v/i, '')
else throw new Error(`Invalid bump target: ${bumpArg}`)

if (compareSemver(nextVersion, pkg.version) <= 0) {
  throw new Error(`Next version (${nextVersion}) must be greater than current version (${pkg.version})`)
}

pkg.version = nextVersion
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: process.env })
run(process.execPath, ['build-client.mjs'])
run(process.execPath, ['scripts/run-unit-tests.mjs'])

run('git', ['add', 'package.json', 'client.js', 'icons.mjs'])
run('git', ['commit', '-m', `release: v${nextVersion}`])
run('git', ['tag', `v${nextVersion}`])

const releaseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
run(process.execPath, ['scripts/update-market-index.mjs', releaseSha])
run('git', ['add', 'market-index.json'])
run('git', ['commit', '-m', `chore: update market-index.json for v${nextVersion} [skip ci]`])

if (!noPush) {
  run('git', ['push', 'origin', 'main', `v${nextVersion}`])
  console.log(`\nReleased dsh-host v${nextVersion} and pushed to GitHub.`)
} else {
  console.log(`\nPrepared dsh-host v${nextVersion} locally (--no-push). Push with: git push origin main v${nextVersion}`)
}
