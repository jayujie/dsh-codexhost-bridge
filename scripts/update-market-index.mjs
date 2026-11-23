import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver, parseSemver } from '../plugin-updater.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const enLocale = JSON.parse(await readFile(path.join(root, 'locale', 'en.json'), 'utf8'))
const zhLocale = JSON.parse(await readFile(path.join(root, 'locale', 'zh.json'), 'utf8'))

const args = process.argv.slice(2)
const flags = new Map()
const positional = []
for (const arg of args) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    if (eq === -1) flags.set(arg.slice(2), true)
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1))
  } else {
    positional.push(arg)
  }
}

const sourceType = flags.get('source') === 'npm' ? 'npm' : 'git'
const registry = typeof flags.get('registry') === 'string' ? flags.get('registry') : undefined
const commit = (positional[0] || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toLowerCase()
if (sourceType === 'git' && !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`Expected a 40-hex commit SHA, got: ${commit}`)
}
const publishTimestamp = Number(positional[1] || execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: root, encoding: 'utf8' }).trim())
if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0) {
  throw new Error(`Invalid Unix publish timestamp: ${publishTimestamp}`)
}
if (!parseSemver(pkg.version)) {
  throw new Error(`Invalid SemVer version in package.json: ${pkg.version}`)
}

const repoUrl = 'https://github.com/jayujie/dsh-host'
const indexPath = path.join(root, 'market-index.json')
let previousVersions = []
if (existsSync(indexPath)) {
  try {
    const existing = JSON.parse(await readFile(indexPath, 'utf8'))
    const prevPlugin = existing?.plugins?.find(p => p?.name === pkg.name)
    if (Array.isArray(prevPlugin?.versions)) previousVersions = prevPlugin.versions
  } catch {}
}

const nextEntry = {
  version: pkg.version,
  publishTimestamp,
  source: sourceType === 'npm'
    ? { type: 'npm', ...(registry ? { registry } : {}) }
    : { type: 'git', url: repoUrl, commit },
  engines: {
    dsh: pkg.engines.dsh,
  },
}

const mergedVersions = [
  nextEntry,
  ...previousVersions.filter(v => v && v.version !== pkg.version && parseSemver(v.version)),
].sort((a, b) => compareSemver(b.version, a.version))

const index = {
  format: 1,
  title: {
    en: 'DSH Host Plugin Index',
    zh: 'DSH Host 插件源',
  },
  description: {
    en: 'Official plugin market index for dsh-host (Codex, Claude Code, and Antigravity inside DSH).',
    zh: 'dsh-host 官方自定义插件源（在 DSH 中原生运行 Codex、Claude Code 与 Antigravity）。',
  },
  metadata: {
    categories: {
      agents: {
        title: {
          en: 'External Agents',
          zh: '外部执行引擎',
        },
      },
    },
    labels: {
      windows: {
        title: {
          en: 'Windows',
          zh: 'Windows',
        },
      },
      'multi-agent': {
        title: {
          en: 'Multi-Agent',
          zh: '多引擎',
        },
      },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: {
        en: enLocale.meta.title,
        zh: zhLocale.meta.title,
      },
      description: {
        en: enLocale.meta.description,
        zh: zhLocale.meta.description,
      },
      icon: './icon.svg',
      author: 'jayujie',
      homepage: pkg.homepage,
      repository: {
        url: repoUrl,
      },
      metadata: {
        category: 'agents',
        keywords: pkg.keywords ?? [],
        labels: ['windows', 'multi-agent'],
        sortKeys: {},
      },
      versions: mergedVersions,
    },
  ],
}

await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n')
console.log(`Updated market-index.json -> ${pkg.name}@${pkg.version} (${sourceType === 'npm' ? 'npm' : commit}, ${mergedVersions.length} version(s) total)`)
