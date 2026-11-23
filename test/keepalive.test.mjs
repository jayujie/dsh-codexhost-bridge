import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver } from '../native-session-driver.mjs'

test('typed busy only for exact local pre-admission rejection; wait does not connect',async()=>{
 const f=fixture();let waited=0;f.agent.whenIdle=async()=>{waited++};
 f.agent.runMaintenance=()=>{throw Error('agent "s" already has active work')};
 try{
  const options={expectedReply:'OK',maxCostUsd:.15,signal:f.controller.signal};let busy;
  await assert.rejects(f.driver.keepalive('s',options),e=>{busy=e;return e.code==='HOST_KEEPALIVE_BUSY'&&e.requestDispatched===false});
  assert.equal(f.calls.length,0);await busy.whenIdle();assert.equal(waited,1);assert.equal(f.calls.length,0);
 }finally{await f.driver.dispose()}
});
test('same text after maintenance admission is NOT safe busy',async()=>{
 const f=fixture();f.agent.whenIdle=async()=>{};f.agent.session.snapshotEvents=()=>{throw Error('agent "s" already has active work')};
 try{await assert.rejects(f.driver.keepalive('s',{expectedReply:'OK',maxCostUsd:.15,signal:f.controller.signal}),e=>e.code!=='HOST_KEEPALIVE_BUSY');assert.equal(f.calls.length,0)}finally{await f.driver.dispose()}
});
function fixture(){const calls=[],controller=new AbortController();let preset='codexhost-claude-code';const agent={id:'s',session:{id:'s',header:{},snapshotEvents:()=>[{type:'plugin:codexhost/thread',ignorable:true,data:{version:1,phase:'ready',harnessId:'claude-code',threadId:'t',sessionId:'s'}}]},runMaintenance:fn=>fn()};const peer={closed:new Promise(()=>{}),subscribe:()=>()=>{},request:async(method,params)=>{calls.push({method,params});if(method==='dsh/claude/keepalive'){controller.abort();return{detached:true}}return{}}};const ctx={agents:{list:()=>[agent]},agentPresets:{presetForSession:()=>preset}};return {driver:new NativeSessionDriver(ctx,{}, {connect:async()=>peer}),agent,calls,controller,set preset(value){preset=value}}}
test('private keepalive uses owned exact thread and sends explicit cancellation',async()=>{const f=fixture();assert.equal((await f.driver.keepalive('s',{expectedReply:'OK',maxCostUsd:.15,signal:f.controller.signal})).detached,true);assert.equal(f.calls[0].params.threadId,'t');assert.equal(f.calls[1].method,'dsh/claude/keepalive/cancel');assert.equal(f.calls[0].params.operationId,f.calls[1].params.operationId);assert.equal(f.calls.some(c=>c.method==='turn/start'),false)})
for (const status of ['running', 'stopping']) test(`idle session can keepalive with detached DSH jobs (${status})`,async()=>{
 const calls=[],jobs=[{owner:'s',status},{owner:'other',status}],agent={id:'s',session:{header:{},snapshotEvents:()=>[{type:'plugin:codexhost/thread',ignorable:true,data:{version:1,phase:'ready',harnessId:'claude-code',threadId:'t',sessionId:'s'}}]},runMaintenance:fn=>fn()};
 const before=structuredClone(jobs);
 const ctx={agents:{list:()=>[agent]},agentPresets:{presetForSession:()=> 'codexhost-claude-code'},get:name=>name==='jobs'?{list:()=>jobs}:undefined};
 const peer={closed:new Promise(()=>{}),close:()=>{},subscribe:()=>()=>{},request:async(method,params)=>{calls.push({method,params});return {detached:true}}};
 const driver=new NativeSessionDriver(ctx,{}, {connect:async()=>peer});
 try{assert.equal((await driver.keepalive('s',{expectedReply:'OK',maxCostUsd:.15,signal:new AbortController().signal})).detached,true);assert.deepEqual(calls.map(c=>c.method),['dsh/claude/keepalive']);assert.equal(calls[0].params.threadId,'t');assert.deepEqual(jobs,before)}finally{await driver.dispose()}
});
test('active local conversation still rejects keepalive before connecting',async()=>{
 const f=fixture();f.agent.runMaintenance=()=>{throw Error('already has active work')};
 try{await assert.rejects(async()=>f.driver.keepalive('s',{expectedReply:'OK',maxCostUsd:.15,signal:f.controller.signal}),/active work/);assert.equal(f.calls.length,0)}finally{await f.driver.dispose()}
});
test('submitted mapping still rejects keepalive before connecting',async()=>{
 const f=fixture();f.agent.session.snapshotEvents=()=>[{type:'plugin:codexhost/thread',ignorable:true,data:{version:1,phase:'submitted',harnessId:'claude-code',threadId:'t',sessionId:'s'}}];
 try{await assert.rejects(f.driver.keepalive('s',{expectedReply:'OK',maxCostUsd:.15,signal:f.controller.signal}),/忙碌|未确认/);assert.equal(f.calls.length,0)}finally{await f.driver.dispose()}
});

test('Codex, unknown session and subagent cannot use Claude keepalive',async()=>{const f=fixture();const options={expectedReply:'OK',maxCostUsd:.15,signal:f.controller.signal};await assert.rejects(f.driver.keepalive('missing',options));f.preset='codexhost-codex';await assert.rejects(f.driver.keepalive('s',options));f.preset='codexhost-claude-code';f.agent.session.header.origin='subagent';await assert.rejects(f.driver.keepalive('s',options));assert.equal(f.calls.length,0)})
