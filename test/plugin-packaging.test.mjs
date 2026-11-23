import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCodexHostAppDir, buildPatchedBackend, backendPatchFingerprint } from '../backend-builder.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('package.json satisfies DSH plugin manager & plugin market packaging rules', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-host')
  assert.equal(pkg.private, false)
  assert.equal(pkg.icon, './icon.svg')
  assert.equal(pkg.dsh?.manifestVersion, 1)
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh?.bundle?.platforms, ['win32'])
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(typeof pkg.engines?.dsh, 'string')
  assert.ok(!pkg.engines.dsh.startsWith('workspace:'))
  assert.equal(pkg.optionalDependencies?.['@codexhost/cli-win32-x64'], '0.17.4')
  assert.equal(pkg.scripts?.prepare, undefined, 'Avoid pnpm git-prepare build-approval prompts')
  assert.equal(pkg.scripts?.postinstall, undefined, 'Avoid pnpm postinstall build-approval prompts')
  for (const key of ['.', './client', './icon', './cordis.patch.yml', './locale/*.json', './package.json']) {
    assert.ok(Object.hasOwn(pkg.exports, key), `missing export ${key}`)
  }
  const iconStat = await stat(path.join(root, pkg.icon))
  assert.ok(iconStat.isFile() && iconStat.size > 0 && iconStat.size <= 256 * 1024)
  for (const lang of ['en', 'zh']) {
    const loc = JSON.parse(await readFile(path.join(root, 'locale', `${lang}.json`), 'utf8'))
    assert.ok(loc.meta?.title && loc.meta?.description && loc.meta?.detail)
    assert.ok(existsSync(path.join(root, loc.meta.detail)), `detail file missing: ${loc.meta.detail}`)
  }
  const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*dsh-host/)
  assert.match(patch, /name:\s*['"]?dsh-host['"]?/)
})

test('pure-Node backend auto-provisioning builds syntax-valid ESM without esbuild when upstream is present', async (t) => {
  const sourceDir = findCodexHostAppDir({ allowNpmLookup: false })
  if (!sourceDir) {
    t.skip('Upstream CodexHost 0.17.4 app directory is not installed in this environment')
    return
  }
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'dsh-host-provision-'))
  try {
    const outDir = path.join(tempRoot, 'runtime')
    const fp = await backendPatchFingerprint()
    assert.match(fp, /^[a-f0-9]{16}$/)
    const built = await buildPatchedBackend({ sourceDir, outDir, useEsbuild: false, atomic: true })
    assert.ok(built.buildTool.includes('pure-esm'))
    for (const rel of ['host-runtime.mjs', 'plugins/claude-code/plugin.mjs', 'plugins/antigravity/plugin.mjs', 'plugins/codex-usage/plugin.mjs', 'plugins/deepseek-harness/plugin.mjs']) {
      const full = path.join(outDir, rel)
      assert.ok(existsSync(full), `missing ${rel}`)
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' })
    }
    const manifest = JSON.parse(await readFile(path.join(outDir, 'build-manifest.json'), 'utf8'))
    assert.equal(Object.keys(manifest.files).length, 5)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
