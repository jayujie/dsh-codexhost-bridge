import test from 'node:test'
import assert from 'node:assert/strict'
import { AutonomousTeamCollaboration, AUTONOMOUS_COLLABORATION } from '../autonomous-team-collaboration.mjs'
import { installCollaborationBridge } from '../host-collaboration.mjs'

function fixture() {
  const events = [{ type: 'plugin:dsh-host/thread', ignorable: true, data: { version: 1, harnessId: 'claude-code', phase: 'ready', threadId: 'thread', sessionId: 'agent' } }]
  const life = new AbortController(), maintenance = new AbortController(), calls = []
  const state = { loaded: [], status: 'active', turns: [{ id: 'autonomous-turn', status: 'inProgress', items: [] }], flushes: 0, disposed: 0, stopped: false, requested: false, owner: 'claude-code', allowed: true, reads: 0 }
  const agent = { id: 'agent', status: 'idle', model: { current: () => ({ provider: 'fixture', model: 'fixture' }) }, session: { header: {}, snapshotEvents: () => events, append(type, data) { events.push({ type, data, ignorable: true }) } }, async runMaintenance(fn) { assert.equal(state.maintenance, undefined); state.maintenance = true; try { return await fn(maintenance.signal) } finally { state.maintenance = undefined } }, inject() { assert.fail('Autonomous task calls must not inject model input') } }
  state.loaded = [agent]
  const schema = name => ({ name, parameters: { type: 'object', properties: {} } })
  const ctx = { agents: { list: () => state.loaded }, subagents: { namesOf: () => ({ self: 'lead' }) }, sessionPersistence: { async flush() { state.flushes++; if (state.failFlush === state.flushes) throw new Error('fixture storage error') } }, tools: {
    async resolve({ signal }) { signal.throwIfAborted(); return { dispose() { state.disposed++ } } },
    schemas: () => state.allowed ? ['team_task_create','team_task_list','team_task_get','team_task_update','subagent','send_message'].map(schema) : [],
    get: name => state.allowed && name.startsWith('team_task_') ? schema(name) : undefined,
    async execute(input) { calls.push(input); assert.equal(input.log, undefined); assert.equal(input.agent, agent); if (state.onExecute) return state.onExecute(input); return { results: [{ result: { content: [{ type: 'text', text: '{"status":"completed","revision":4}' }] } }], additionalContexts: [] } },
  } }
  const peer = { async request(method, params, { signal }) { state.methods = [...(state.methods ?? []), [method, params.itemsView ?? params.includeTurns]]; signal.throwIfAborted(); state.reads++; if (state.onRead) await state.onRead(state.reads); return method === 'thread/turns/list' ? { data: [...state.turns].reverse().slice(0, params.limit), nextCursor: null } : { thread: { id: params.threadId, status: { type: state.status }, turns: [] } } } }
  const helpers = { ToolCallId: id => id, appendPluginRecord: (session, type, data) => session.append(type, data) }
  const bridge = new AutonomousTeamCollaboration(ctx, helpers, { connect: async () => peer, owner: () => state.owner, isRequested: () => state.requested, isStopped: () => state.stopped, lifecycleSignal: life.signal, bound: r => r })
  const request = { threadId: 'thread', id: 'mcp:1', name: 'team_task_update', arguments: { task_id: 'task-1', expected_revision: 3, action: 'complete' } }
  return { bridge, request, state, agent, events, calls, life, maintenance, ctx, helpers }
}

test('active autonomous Claude Turn uses current scoped executor without a local Turn, Step or model input', async () => {
  const f=fixture(), r=await f.bridge.call(f.request)
  assert.equal(r.isError, undefined); assert.equal(f.calls.length,1); assert.equal(f.state.disposed,1)
  assert.deepEqual(f.events.slice(1).map(e=>[e.type,e.data.phase]),[[AUTONOMOUS_COLLABORATION,'request'],[AUTONOMOUS_COLLABORATION,'result']])
  assert.ok(f.events.slice(1).every(e=>e.ignorable===true && e.data.hostTurnId==='autonomous-turn' && !('turn' in e.data)))
  assert.ok(f.state.methods.every(([m,v])=>m==='thread/read'?v===false:v==='notLoaded'),'ownership checks never pull full history or Items')
})
test('discovery exposes only four Team tools and no delegation or message capabilities', async () => {
  const f=fixture(),r=await f.bridge.call({...f.request,name:'__list__',arguments:{}}), data=JSON.parse(r.content[0].text)
  assert.deepEqual(data.tools.map(t=>t.name),['team_task_create','team_task_list','team_task_get','team_task_update']);assert.equal(f.calls.length,0)
})
for(const name of ['subagent','send_message','list_agents','program','team_task_other']) test(`autonomous path refuses ${name}`,async()=>{const f=fixture(),r=await f.bridge.call({...f.request,name});assert.equal(r.error.code,'COLLABORATION_DSH_REQUEST_REQUIRED');assert.equal(f.calls.length,0)})
for(const change of ['idle','zero','multiple']) test(`refuses native ${change} state`,async()=>{const f=fixture();if(change==='idle')f.state.status='idle';if(change==='zero')f.state.turns=[];if(change==='multiple')f.state.turns.push({id:'other',status:'inProgress',items:[]});const r=await f.bridge.call(f.request);assert.equal(r.error.code,'COLLABORATION_NATIVE_TURN_INACTIVE');assert.equal(f.calls.length,0)})
test('unowned, duplicated, foreign-session and Codex mappings cannot obtain autonomous authority',async()=>{
 for(const mode of ['unloaded','duplicated','foreign','codex']){const f=fixture();if(mode==='unloaded')f.state.loaded=[];if(mode==='duplicated')f.state.loaded.push({...f.agent});if(mode==='foreign')f.events[0].data.sessionId='foreign';if(mode==='codex')f.state.owner='codex';assert.equal(await f.bridge.call(f.request),undefined);assert.equal(f.calls.length,0)}
})
test('local requested work rejects autonomous requests without waiting or replaying',async()=>{const f=fixture();f.state.requested=true;assert.equal((await f.bridge.call(f.request)).error.code,'COLLABORATION_AGENT_BUSY');assert.equal(f.calls.length,0)})
test('Team removal after resolution and native Turn change both reject before dispatch',async()=>{
 const f=fixture();f.state.allowed=false;assert.equal((await f.bridge.call(f.request)).error.code,'COLLABORATION_TEAM_UNAVAILABLE');assert.equal(f.calls.length,0)
 const g=fixture();g.state.onRead=n=>{if(n===3)g.state.turns=[{id:'changed',status:'inProgress',items:[]}]};assert.equal((await g.bridge.call(g.request)).error.code,'COLLABORATION_NATIVE_TURN_CHANGED');assert.equal(g.calls.length,0)
})
test('settled receipts survive bridge recreation; conflicting ids and incomplete receipts never dispatch twice',async()=>{
 const f=fixture();await f.bridge.call(f.request);assert.equal(f.calls.length,1);f.bridge = new AutonomousTeamCollaboration(f.ctx,f.helpers,f.bridge);await f.bridge.call(f.request);assert.equal(f.calls.length,1)
 assert.equal((await f.bridge.call({...f.request,arguments:{different:true}})).error.code,'COLLABORATION_REQUEST_CONFLICT')
 f.events.pop();assert.equal((await f.bridge.call(f.request)).error.code,'COLLABORATION_OUTCOME_UNKNOWN');assert.equal(f.calls.length,1)
})
test('cached receipt still requires current scoped Team admission',async()=>{const f=fixture();await f.bridge.call(f.request);f.state.allowed=false;assert.equal((await f.bridge.call(f.request)).error.code,'COLLABORATION_TEAM_UNAVAILABLE');assert.equal(f.calls.length,1)})
test('cancellation stops waiting for a shared connection without hanging maintenance',async()=>{const f=fixture();f.bridge.connect=()=>new Promise(()=>{});const running=f.bridge.call(f.request);f.life.abort();assert.equal((await running).error.code,'COLLABORATION_EXECUTION_UNCONFIRMED');await f.bridge.drain();assert.equal(f.calls.length,0)})
test('different native Turns do not reuse the previous Turn receipt',async()=>{const f=fixture();await f.bridge.call(f.request);f.state.turns=[{id:'new-turn',status:'inProgress',items:[]}];await f.bridge.call(f.request);assert.equal(f.calls.length,2)})
test('concurrent requests are explicitly busy; they never acquire a second maintenance task',async()=>{
 const f=fixture();let release,entered;const start=new Promise(r=>entered=r),wait=new Promise(r=>release=r);f.state.onExecute=async()=>{entered();await wait;return{results:[{result:{content:[{type:'text',text:'ok'}]}}],additionalContexts:[]}}
 const first=f.bridge.call(f.request);await start;assert.equal((await f.bridge.call({...f.request,id:'other'})).error.code,'COLLABORATION_AGENT_BUSY');release();await first;await f.bridge.drain();assert.equal(f.calls.length,1)
})
test('request persistence failure refuses execution; result persistence failure retains unknown outcome without replay',async()=>{
 const f=fixture();f.state.failFlush=1;assert.equal((await f.bridge.call(f.request)).error.code,'COLLABORATION_EXECUTION_UNCONFIRMED');assert.equal(f.calls.length,0)
 const g=fixture();g.state.failFlush=2;assert.equal((await g.bridge.call(g.request)).error.code,'COLLABORATION_EXECUTION_UNCONFIRMED');assert.equal(g.calls.length,1);g.state.failFlush=3;assert.equal((await g.bridge.call(g.request)).error.code,'COLLABORATION_EXECUTION_UNCONFIRMED');assert.equal(g.calls.length,1);assert.notEqual((await g.bridge.call(g.request)).isError,true);assert.equal(g.calls.length,1)
})
test('unload cancellation is delivered to the real executor signal and drained',async()=>{
 const f=fixture();let entered;const started=new Promise(r=>entered=r);f.state.onExecute=input=>new Promise(resolve=>{input.signal.addEventListener('abort',()=>resolve({results:[{result:{isError:true,content:[{type:'text',text:'cancelled'}]}}],additionalContexts:[]}),{once:true});entered()});const running=f.bridge.call(f.request);await started;f.life.abort();await running;await f.bridge.drain();assert.equal(f.bridge.pending.size,0);assert.equal(f.state.disposed,1)
})
test('normal tool permission or CAS denial is returned without automatic revision changes',async()=>{const f=fixture();f.state.onExecute=async()=>({results:[{result:{isError:true,content:[{type:'text',text:'stale revision'}]}}],additionalContexts:[]});const r=await f.bridge.call(f.request);assert.equal(r.isError,true);assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].calls[0].arguments).expected_revision,3)})
test('authenticated existing HTTP callback uses autonomous fallback while unrelated Threads remain forbidden',async()=>{
 const f=fixture(),cleanups=[];const installed=await installCollaborationBridge({effect:factory=>cleanups.push(factory())},{collaborationFor:()=>undefined,callAutonomousCollaboration:r=>f.bridge.call(r)},{});
 try{const send=(token,threadId='thread')=>fetch(installed.environment.DSH_COLLABORATION_URL,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({...f.request,threadId})});assert.equal((await send('bad')).status,403);assert.equal((await send(installed.environment.DSH_COLLABORATION_TOKEN,'foreign')).status,403);const response=await send(installed.environment.DSH_COLLABORATION_TOKEN);assert.equal(response.status,200);assert.equal((await response.json()).isError,undefined);assert.equal(f.calls.length,1)}finally{for(const cleanup of cleanups.reverse())await cleanup()}
})
