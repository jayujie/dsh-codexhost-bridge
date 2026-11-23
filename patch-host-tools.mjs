import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Preserve native tool observations that Codex UI compatibility intentionally hides. */
export function patchedHostTools(source) {
  if (source.includes('method: "codexhost/item/started"')) throw new Error('Host tool observation patch is already installed')
  for (const [phase, fn] of [['started', '#startItem'], ['completed', '#completeItem']]) {
    const original = `case "item.${phase}":\n        return this.${fn}(event, emittedAtMs);`
    if (source.split(original).length !== 2) throw new Error('Installed Host does not match the verified native item projection')
    const item = phase === 'started' ? 'event.item' : 'event.snapshot.item'
    source = source.replace(original, `case "item.${phase}": {\n        const projection = this.${fn}(event, emittedAtMs);\n        const item = ${item};\n        if (!["toolExecution", "commandExecution", "fileChange", "subagentDelegation"].includes(item.type)) return projection;\n        return { ...projection, messages: [{ method: "codexhost/item/${phase}", emittedAtMs, params: { threadId: this.#threadId, turnId: this.#turnId, item${phase === 'completed' ? ', outcome: event.snapshot.outcome' : ''} } }, ...projection.messages] };\n      }`)
  }
  return source
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sourcePath, outputPath] = process.argv.slice(2)
  if (!sourcePath || !outputPath || sourcePath === outputPath) throw new Error('Use separate source and review output paths')
  await writeFile(outputPath, patchedHostTools(await readFile(sourcePath, 'utf8')))
}
