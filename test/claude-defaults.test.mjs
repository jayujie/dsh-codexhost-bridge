import test from 'node:test'
import assert from 'node:assert/strict'
import {NativeSessionDriver} from '../native-session-driver.mjs'
const ref=value=>'claude-model-v1.'+Buffer.from(value).toString('base64url')
function fixture({child=false,saved,mapped,missing}={}){
 const events=[],calls=[]
 const session={id:'claude-default-fixture',header:{cwd:'D:/work',...(child?{origin:'subagent',parentSession:'parent'}:{})},snapshotEvents:()=>events,append(type,data){const event={type,data,seq:events.length,ignorable:type.startsWith('plugin:')};events.push(event);return event}}
 if(saved)session.append('plugin:dsh-host/configuration',{harnessId:'claude-code',modelId:ref(saved)})
 if(mapped)session.append('plugin:dsh-host/thread',{version:1,sessionId:session.id,phase:'ready',harnessId:'claude-code',threadId:'existing-thread',appliedConfiguration:{modelId:ref(mapped),permissionModeId:child?'plan':'default'}})
 const models=['default','haiku','sonnet','opus'].filter(value=>value!==missing).map(value=>({ref:{id:ref(value)},label:value,thinkingOptions:[{id:'low',label:'low'}]}))
 const peer={closed:new Promise(()=>{}),subscribe:()=>()=>{},close(){},async request(method){calls.push(method);if(method!=='codexhost/harness/inspect')throw Error('Catalog policy must not submit models or read histories');return{status:'ready',catalog:{models,defaultModel:{id:ref('default')}},permissionModes:{modes:[{id:'default'},{id:'plan'},{id:'bypassPermissions'}],defaultModeId:'default'}}}}
 const driver=new NativeSessionDriver({agentPresets:{presetForSession:()=> 'dsh-host-claude-code'},sessionPersistence:{async flush(){}}},{appendPluginRecord:(s,type,data)=>s.append(type,data)},{connect:async()=>peer})
 const agent={id:session.id,session,runMaintenance:fn=>fn()}
 return{driver,agent,events,calls}
}
for(const [child,expected]of [[false,'opus'],[true,'sonnet']]){
 test(`new Claude ${child?'subagent':'main'} defaults to ${expected}, not native default`,async()=>{const f=fixture({child});const catalog=await f.driver.catalog(f.agent);assert.equal(catalog.status,'ready');assert.equal(catalog.selection.modelId,ref(expected));assert.deepEqual(f.calls,['codexhost/harness/inspect']);await f.driver.dispose()})
 test(`explicit Claude ${child?'child':'main'} model is preserved`,async()=>{const f=fixture({child,saved:'haiku'});assert.equal((await f.driver.catalog(f.agent)).selection.modelId,ref('haiku'));await f.driver.dispose()})
 test(`existing Claude ${child?'child':'main'} default mapping does not silently migrate`,async()=>{const f=fixture({child,mapped:'default'});assert.equal((await f.driver.catalog(f.agent)).selection.modelId,ref('default'));await f.driver.dispose()})
 test(`an unstarted default draft becomes ${expected}`,async()=>{const f=fixture({child,saved:'default'});assert.equal((await f.driver.catalog(f.agent)).selection.modelId,ref(expected));await f.driver.dispose()})
}
test('an existing non-default child mapping is not replaced with Sonnet',async()=>{const f=fixture({child:true,mapped:'opus'});assert.equal((await f.driver.catalog(f.agent)).selection.modelId,ref('opus'));await f.driver.dispose()})
test('missing preferred model fails explicitly instead of selecting another model',async()=>{const f=fixture({child:true,missing:'sonnet'});const catalog=await f.driver.catalog(f.agent);assert.equal(catalog.status,'error');assert.equal(catalog.errorCode,'HOST_MODEL_UNAVAILABLE');assert.match(catalog.error,/sonnet/);await f.driver.dispose()})
test('an unavailable saved model is reported accurately and never replaced',async()=>{const f=fixture({saved:'haiku',missing:'haiku'});const catalog=await f.driver.catalog(f.agent);assert.equal(catalog.errorCode,'HOST_MODEL_UNAVAILABLE');assert.match(catalog.error,/saved Claude model/);assert.equal(f.events[0].data.modelId,ref('haiku'));await f.driver.dispose()})
test('removed default alias cannot be selected through a direct configuration call',async()=>{const f=fixture();await assert.rejects(f.driver.configure(f.agent,{modelId:ref('default')}),{code:'HOST_MODEL_INVALID'});assert.equal(f.events.length,0);await f.driver.dispose()})
test('legacy default sessions may change permissions without an implicit model switch',async()=>{const f=fixture({mapped:'default'});const result=await f.driver.configure(f.agent,{permissionModeId:'plan'});assert.equal(result.selection.modelId,ref('default'));assert.equal(result.selection.permissionModeId,'plan');await f.driver.dispose()})
