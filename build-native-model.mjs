// Build the upstream native ModelSelect with one optional effort-pane renderer.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const root = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(root, '../../client/ui-model-selection/src/client/ModelSelect.tsx')
if (!process.env.DSH_HOST_ESBUILD_PATH || !process.env.DSH_HOST_CLSX_PATH) throw new Error('Provide DSH_HOST_ESBUILD_PATH and DSH_HOST_CLSX_PATH')
const { build } = await import(pathToFileURL(process.env.DSH_HOST_ESBUILD_PATH).href)
const original = await readFile(source, 'utf8')
let patched = original
function replaceOnce(from, to) {
  if (patched.split(from).length !== 2) throw new Error('Upstream ModelSelect changed: review the effort renderer adaptation')
  patched = patched.replace(from, to)
}
replaceOnce('type CSSProperties, type KeyboardEvent, type FocusEvent,', 'type CSSProperties, type KeyboardEvent, type FocusEvent, type ComponentType,')
replaceOnce('{ locked, available, directory, load, select, resolveText, t, renderSlot }:', '{ locked, available, directory, load, select, resolveText, t, renderSlot, EffortPane }:')
replaceOnce("& Omit<PropsRenderSlots<'conversation.input.model.label' | 'conversation.input.model.options'>, 'SessionProvider'>,", "& Omit<PropsRenderSlots<'conversation.input.model.label' | 'conversation.input.model.options'>, 'SessionProvider'>\n    & { EffortPane?: ComponentType<{ label: string; modelLabel: string; options: { id: string | undefined; label: string }[]; selected: string | undefined; disabled: boolean; saving: boolean; onSelect: (id: string | undefined) => void }> },")
replaceOnce("const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {", "const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>, keepOpen = false): void => {")
replaceOnce('if (rootRef.current !== null) closeAfterSelection()', 'if (rootRef.current !== null && !keepOpen) closeAfterSelection()')
replaceOnce('const submit = (selection: ModelSelection): void => {', 'const submit = (selection: ModelSelection, keepOpen = false): void => {')
replaceOnce('void select(selection).then(settleSelection)', 'void select(selection).then(result => settleSelection(result, keepOpen))')
replaceOnce(`    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection)`, `    if (!keepOpen) {
      setSelectionFocus(true)
      triggerRef.current?.focus()
    }
    void select(selection)`)
replaceOnce(`    if (effectiveEffort === effort) {
      closeAfterSelection()
      return
    }`, `    if (effectiveEffort === effort) {
      if (!EffortPane) closeAfterSelection()
      return
    }`)
replaceOnce(`    submit(selection)
  }

  const waiting`, `    submit(selection, EffortPane !== undefined)
  }

  const waiting`)
const start = patched.indexOf("          {pane === 'effort' && (")
const end = patched.indexOf('\n        </MenuSurface>', start)
if (start < 0 || end < 0) throw new Error('Missing native effort pane')
const block = patched.slice(start, end)
patched = patched.slice(0, start) + block.replace("{pane === 'effort' && (", "{pane === 'effort' && (EffortPane ? <EffortPane label={t('menu.effort')} modelLabel={modelLabel} options={effortChoices.map(level => ({ id: level.effort, label: level.label }))} selected={effectiveEffort} disabled={busy || locked} saving={busy} onSelect={chooseEffort} /> : (").replace(/\n          \)}$/, '\n          ))}') + patched.slice(end)
const result = await build({ stdin: { contents: patched, sourcefile: source, resolveDir: path.dirname(source), loader: 'tsx' }, bundle: true, format: 'cjs', platform: 'browser', jsx: 'automatic', outfile: 'model.js', write: false, minify: true, external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], alias: { clsx: process.env.DSH_HOST_CLSX_PATH }, metafile: true, legalComments: 'inline' })
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text
const output = `// Generated from native ModelSelect by build-native-model.mjs; only the effort pane gains a renderer.\nimport * as React from 'react'\nimport * as ReactDOM from 'react-dom'\nimport * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'\nexport const nativeModelCss = ${JSON.stringify(css)}\nlet nativeModelComponent\nexport function getNativeModelSelect() {\n  if (nativeModelComponent) return nativeModelComponent\n  const module = { exports: {} }\n  const jsx = (type, props, key) => React.createElement(type, key === undefined ? props : { ...props, key })\n  const require = id => {\n    if (id === 'react') return React\n    if (id === 'react-dom') return ReactDOM\n    if (id === 'react/jsx-runtime') return { Fragment: React.Fragment, jsx, jsxs: jsx }\n    if (id === '@deepseek-ai/dsh-client-ui-primitives') return UiPrimitives\n    throw new Error('Unexpected native model external: ' + id)\n  }\n${js}\n  nativeModelComponent = module.exports.ModelSelect\n  return nativeModelComponent\n}\n`
await writeFile(path.join(root, 'native-model-runtime.mjs'), output)
const sha = data => createHash('sha256').update(data).digest('hex')
await writeFile(path.join(root, 'native-model-build-manifest.json'), JSON.stringify({ source: 'packages/client/ui-model-selection/src/client/ModelSelect.tsx', sourceSha256: sha(original), patchedSha256: sha(patched), outputSha256: sha(output), adaptation: 'optional EffortPane renderer; upstream model UI and CSS retained', inputs: Object.keys(result.metafile.inputs) }, null, 2) + '\n')
console.log('Built native ModelSelect with an optional effort pane')
