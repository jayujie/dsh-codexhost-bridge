import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

// The native control has no published component export. Bundle its unchanged
// source and CSS, instead of replacing its DOM, styles or interactions.
const require = createRequire(import.meta.url)
const { build } = require(process.env.CODEXHOST_ESBUILD_PATH ?? 'C:/Users/example/AppData/Local/npm-cache/_npx/9ed06546b0653f96/node_modules/esbuild/lib/main.js')
const result = await build({ entryPoints: [new URL('./vendor/dsh-context/skeleton/ContextMeter.tsx', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')], bundle: true, write: false, outdir: 'native-context-build', format: 'cjs', platform: 'browser', jsxFactory: 'React.createElement', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const code = result.outputFiles.find(file => file.path.endsWith('.js')).text
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text
await writeFile(new URL('./native-context.mjs', import.meta.url), `// Generated from unchanged DSH ContextMeter sources; see vendor/dsh-context.\nimport * as React from 'react'\nimport * as ReactDOM from 'react-dom'\nimport * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'\nexport const ContextMeter = (()=>{const module={exports:{}};const require=name=>name==='react'?React:name==='react-dom'?ReactDOM:UiPrimitives;\n${code}\nreturn module.exports.ContextMeter})();\nexport const nativeContextCss=${JSON.stringify(css)}\n`)
