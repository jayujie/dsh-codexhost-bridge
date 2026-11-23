import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPatchedBackend } from './backend-builder.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const sourceDir = process.argv[2]
if (!sourceDir) throw new Error('Provide the reviewed CodexHost 0.17.4 app directory (e.g. via scripts/setup-backend.mjs)')

const result = await buildPatchedBackend({
  sourceDir,
  outDir: path.join(root, 'backend'),
  useEsbuild: process.env.DSH_HOST_NO_ESBUILD !== '1',
  atomic: false,
})
console.log(JSON.stringify({ originalRuntimeBytes: result.originalRuntimeBytes, buildTool: result.buildTool, files: result.files }, null, 2))
