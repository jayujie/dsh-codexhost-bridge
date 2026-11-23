import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const enLocale = JSON.parse(await readFile(path.join(root, 'locale', 'en.json'), 'utf8'))
const zhLocale = JSON.parse(await readFile(path.join(root, 'locale', 'zh.json'), 'utf8'))

const commit = (process.argv[2] || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toLowerCase()
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`Expected a 40-hex commit SHA, got: ${commit}`)
}
const publishTimestamp = Number(process.argv[3] || execFileSync('git', ['show', '-s', '--format=%ct', commit], { cwd: root, encoding: 'utf8' }).trim())
if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0) {
  throw new Error(`Invalid Unix publish timestamp: ${publishTimestamp}`)
}

const repoUrl = 'https://github.com/jayujie/dsh-host'
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
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: {
            type: 'git',
            url: repoUrl,
            commit,
          },
          engines: {
            dsh: pkg.engines.dsh,
          },
        },
      ],
    },
  ],
}

await writeFile(path.join(root, 'market-index.json'), JSON.stringify(index, null, 2) + '\n')
console.log(`Updated market-index.json -> ${pkg.name}@${pkg.version} (${commit})`)
