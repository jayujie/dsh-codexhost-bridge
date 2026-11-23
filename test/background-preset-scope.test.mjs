import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { installNativeSessionDriver } from '../native-session-driver.mjs'
import { HostCollaboration } from '../host-collaboration.mjs'

test('external Claude preset explicitly owns its standard shell and job tools rather than inheriting headless globals', async () => {
  const presets=[],effects=[]
  class Service { constructor() {} }
  const helpers={}
  const ctx={loader:{async import(name){return name==='@deepseek-ai/cordis'?{Service}:helpers}},plugin(){},effect(fn){effects.push(fn());},agentPresets:{async register(value){presets.push(value)}},on(){}}
  const driver=await installNativeSessionDriver(ctx,{connect:async()=>{assert.fail('Preset registration must not connect')}})
  try{
    await Promise.all(effects)
    const claude=presets.find(p=>p.id==='codexhost-claude-code'),codex=presets.find(p=>p.id==='codexhost-codex'),agy=presets.find(p=>p.id==='codexhost-antigravity')
    assert.ok(claude.plugins.some(p=>p.name==='@deepseek-ai/dsh-tool-pwsh'))
    assert.ok(claude.plugins.some(p=>p.name==='@deepseek-ai/dsh-tool-jobs'))
    assert.ok(agy.plugins.some(p=>p.name==='@deepseek-ai/dsh-tool-pwsh'))
    assert.ok(agy.plugins.some(p=>p.name==='@deepseek-ai/dsh-tool-jobs'))
    assert.equal(agy.plugins.some(p=>String(p.name).includes('native-command-preset')),true)
    assert.equal(codex.plugins.some(p=>String(p.name).includes('native-command-preset')),false)
    assert.equal(codex.plugins.some(p=>p.name==='@deepseek-ai/dsh-tool-pwsh'),false)
  }finally{await driver.dispose()}
})

test('missing preset background tool returns a specific pre-dispatch error and never executes', async () => {
  const events=[];let executes=0
  const session={snapshotEvents:()=>events,append(type,data){events.push({type,data});return events.at(-1)}}
  const agent={session,model:{current:()=>({provider:'fixture',model:'fixture'})}}
  const ctx={tools:{async resolve(){return{dispose(){}}},schemas:()=>[],get:()=>undefined,async execute(){executes++;assert.fail('Unavailable tool must not execute')}},sessionPersistence:{async flush(){}}}
  const manager=new HostCollaboration(ctx,{appendPluginRecord:(s,t,d)=>s.append(t,d)})
  const lease=await manager.open({agent,turn:1,step:1,signal:new AbortController().signal})
  try{
    const result=await lease.call({id:'list',channel:'background',name:'job_list',arguments:{}})
    assert.equal(result.isError,true);assert.match(result.content[0].text,/BACKGROUND_TOOL_UNAVAILABLE.*job_list/)
    assert.match(result.content[0].text,/No command was started/);assert.equal(executes,0)
    assert.equal(events.at(-1).data.result.isError,true)
  }finally{await manager.close()}
})
