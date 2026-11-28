import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Extend the installed 0.17.4 meter's existing Usage fields, only from complete request history. */
export async function patchedHostUsage(source) {
  if (source.includes('function hostUsageTotals(')) throw new Error('Host usage patch is already installed')
  const header = '// packages/host-runtime/src/usage-metering.ts\n'
  const needle = 'if (this.#historyComplete && !this.#invalidRecord) {'
  if (source.split(header).length !== 2 || source.split(needle).length !== 2) throw new Error('Installed Host runtime does not match the verified usage meter')
  const helper = (await readFile(new URL('./host-usage-totals.mjs', import.meta.url), 'utf8')).replace('export function', 'function')
  return source.replace(header, `${header}${helper}\n`).replace(needle, `${needle}\n        const dshTotals = hostUsageTotals(this.#requests.values());\n        if (dshTotals) Object.assign(usage, dshTotals);`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sourcePath, outputPath] = process.argv.slice(2)
  if (!sourcePath || !outputPath || sourcePath === outputPath) throw new Error('Use separate source and review output paths')
  await writeFile(outputPath, await patchedHostUsage(await readFile(sourcePath, 'utf8')))
}
