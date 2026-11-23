import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { hostModelPresentation } from '../native-ui-projections.mjs'
const source = (await readFile(new URL('../client.mjs', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '')
const NativeComponent = () => {}
const api = vm.runInNewContext(source + '\n;({CatalogDirectory,HostModelSelect,hostModelSnapshot,NativeAgentControls})', {
  h: (tag, props, ...children) => ({tag, props, children}), hostModelPresentation, getNativeModelSelect: () => NativeComponent,
})
const catalog = {agentId:'codex', status:'ready', models:[{id:'m1',label:'Model one',thinkingOptions:[{id:'low',label:'Low'},{id:'high',label:'High'}]},{id:'m2',label:'Model two',thinkingOptions:[{id:'medium',label:'Medium'}]}], selection:{modelId:'m1',thinkingOptionId:'high'}}

test('native model source and generated renderer match their reviewed build manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../native-model-build-manifest.json', import.meta.url), 'utf8'))
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  assert.equal(sha(await readFile(new URL('../native-model-runtime.mjs', import.meta.url))), manifest.outputSha256)
  const monorepoSource = new URL('../../../client/ui-model-selection/src/client/ModelSelect.tsx', import.meta.url)
  if (existsSync(monorepoSource)) assert.equal(sha(await readFile(monorepoSource)), manifest.sourceSha256)
})

test('Host directory adapts exact model/effort IDs with stable snapshots and no guessed model defaults', () => {
  const directory = new api.CatalogDirectory({}, 's')
  directory.set({status:'ready',catalog,error:''})
  const state = directory.modelStore.getSnapshot()
  assert.equal(directory.modelStore.getSnapshot(),state)
  assert.equal(state.current.reasoningEffort,'high')
  assert.equal(state.groups[0].models[0].reasoning.efforts[1].name,'High')
  assert.equal(state.groups[0].models[1].reasoning.defaultEffort,undefined)
  let notified = 0
  const off = directory.modelStore.subscribe(() => notified++)
  directory.set({...directory.state,status:'loading'})
  assert.equal(notified,1)
  assert.notEqual(directory.modelStore.getSnapshot(),state)
  off(); directory.dispose()
})

test('original ModelSelect receives native locale and Team slot, and writes only Host configuration', async () => {
  const requests = []
  const directory = new api.CatalogDirectory({configure:async (...args) => {requests.push(args); return {ok:true,value:catalog}}},'s')
  directory.set({status:'ready',catalog,error:''})
  const Component = () => {}, Team = () => {}, t = key => key
  const control = api.HostModelSelect({hostDirectory:directory,nativeModel:{Component,t},nativeTeam:{Component:Team,injected:{native:true},t},teamProps:{t},disabled:false})
  assert.equal(control.tag,NativeComponent)
  assert.equal(typeof control.props.EffortPane,'function')
  assert.equal(control.props.t,t)
  const owner = {locked:true,dismiss(){},reportFailure(){}}
  assert.equal(control.props.renderSlot('conversation.input.model.options',owner).props.dismiss,owner.dismiss)
  assert.equal(control.props.renderSlot('conversation.input.model.label',{}, {fallback:'Host label'}),'Host label')
  assert.equal((await control.props.select({provider:'codex',model:'m1',reasoningEffort:'low'})).ok,true)
  assert.equal(requests[0][1].thinkingOptionId,'low')
  assert.equal(requests[0][1].modelId,undefined, 'Effort-only changes do not reselect the model')
  assert.equal((await control.props.select({provider:'wrong',model:'m1'})).ok,false)
  assert.equal(requests.length,1)
  directory.dispose()
})

test('native selection errors return failure and clear pending state without replacing the catalog', async () => {
  const directory = new api.CatalogDirectory({configure:async () => {throw Error('offline')}},'s')
  directory.set({status:'ready',catalog,error:''})
  const result = await directory.configure({thinkingOptionId:'low'})
  assert.equal(result.ok,false)
  assert.equal(directory.state.catalog,catalog)
  assert.equal(directory.modelStore.getSnapshot().pending,null)
  assert.equal(directory.state.error,'offline')
})

test('legacy Claude default is retained but cannot be newly selected', async () => {
  const id = 'claude-model-v1.' + Buffer.from('default').toString('base64url')
  const directory = new api.CatalogDirectory({},'s')
  directory.set({status:'ready',error:'',catalog:{agentId:'claude-code',models:[{id,label:'default'}],selection:{modelId:id}}})
  assert.equal(api.hostModelSnapshot(directory.state,'Legacy unchanged').groups[0].models[0].name,'Legacy unchanged')
  const control = api.HostModelSelect({hostDirectory:directory,nativeModel:{Component:()=>{},t:x=>x},teamProps:{t:x=>x}})
  assert.equal((await control.props.select({provider:'claude-code',model:id})).ok,false)
  let configuration
  directory.remote.configure = async (_, value) => {configuration=value;return {ok:true,value:directory.state.catalog}}
  assert.equal((await control.props.select({provider:'claude-code',model:id,reasoningEffort:'high'})).ok,true)
  assert.equal(configuration.modelId,undefined, 'Changing effort in a legacy default Thread never reselects default')
  assert.equal(configuration.thinkingOptionId,'high')
})

test('opening the native menu during selection does not invalidate the pending Host write', async () => {
  let finish, reads = 0
  const directory = new api.CatalogDirectory({catalog:async () => {reads++; return {ok:true,value:catalog}},configure:() => new Promise(resolve => {finish=resolve})},'s')
  directory.set({status:'ready',catalog,error:''})
  const write = directory.configure({thinkingOptionId:'low'})
  await directory.load()
  assert.equal(reads,0)
  assert.equal(directory.modelStore.getSnapshot().pending.reasoningEffort,'low')
  finish({ok:true,value:catalog}); await write
  assert.equal(directory.state.status,'ready')
  directory.dispose()
})

test('the native effort pane renders an inline slider, not a separate footer trigger', () => {
  const footer = source.slice(source.indexOf('function NativeAgentControls('),source.indexOf('// Addressed children'))
  assert.match(footer,/h\(HostModelSelect/)
  assert.doesNotMatch(footer,/h\(ThinkingSlider|h\(NativeRecoveryControl|ch-native-models/)
  assert.match(source,/EffortPane: NativeEffortSliderPane/)
  assert.match(source,/h\(ThinkingSlider, \{ \.\.\.props, inline: true \}\)/)
})
