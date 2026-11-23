// Reuse the reviewed Host price resolver without importing/starting its runtime.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = new URL('./', import.meta.url)
const raw = await readFile(new URL('backend/host-runtime.mjs', root), 'utf8')
const manifest = JSON.parse(await readFile(new URL('backend/build-manifest.json', root), 'utf8'))
if (createHash('sha256').update(raw).digest('hex') !== manifest.files['host-runtime.mjs'].sha256) throw new Error('Backend price source fingerprint mismatch')
const start = raw.indexOf('bundledModelPrices = {')
const end = raw.indexOf('function defaultModelPriceDirectory(', start)
if (start < 0 || end < 0) throw new Error('Host price resolver boundaries changed')
await writeFile(new URL('local-model-prices.mjs', root), '// Generated unchanged Host pricing resolver; MIT, see backend/licenses.\nconst ' + raw.slice(start, end) + '\nexport { bundledModelPrices, ModelPriceLookup, parseModelPriceTable, parseModelPriceOverrides };\n')
