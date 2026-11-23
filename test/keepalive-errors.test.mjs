import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {EventEmitter} from 'node:events'
const method=await readFile(new URL('../claude-keepalive-backend.txt',import.meta.url),'utf8')
const rpc=await readFile(new URL('../keepalive-rpc-backend.txt',import.meta.url),'utf8')
function fixture({stderr='',error,managed=false,result={type:'result',subtype:'success',usage:{input_tokens:1,output_tokens:1},result:'OK'}}={}){
 let closed=0,spawned=0,listeners=0,queryOptions
 const context={setTimeout,clearTimeout,claudeThinkingConfiguration:()=>({enabled:true,effort:'xhigh'}),resolveClaudeCodeExecutable:()=> 'fixture.exe',dshCollaborationMcp:()=>({}),codexhostUaEnvironment:(_,env)=>env,withNodeRuntimeOnPath:x=>x,dshCollaborationChildEnvironment:x=>x,dshNativeWebEnvironment:()=>({}),dshUnifiedWakeOptions:()=>managed?{disallowedTools:['Agent','Task','Workflow','ScheduleWakeup']}: {},dshUnifiedWakeEnvironment:()=>managed?{CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1',CLAUDE_CODE_MAX_RETRIES:'0'}:{},SESSION_ENTRYPOINT:'fixture',CLIENT_APP:'fixture',spawn2:()=>{spawned++;const stream=new EventEmitter();listeners=stream.listenerCount('data');queueMicrotask(()=>{listeners=stream.listenerCount('data');stream.emit('data',Buffer.from(stderr))});return {stderr:stream}},k5t:({options})=>{queryOptions=options;const q=(async function*(){options.spawnClaudeCodeProcess({command:'fixture.exe',args:[],env:{}});await Promise.resolve();if(result)yield result;if(error)throw error})();q.close=()=>closed++;return q}}
 const C=vm.runInNewContext(`(class {
 #phase='open'; #active=false; #acceptingTurn=false; #configurationTask=false; #readingHistory=false; #cwd='fixture'; #sessionId='s'; #requestedThinkingOptionId='xhigh'; #dshEnvironment={};
 hasBackgroundWork(){return false}
 async #readSessionMessages(){return [{type:'assistant',message:{stop_reason:'end_turn',model:'claude-fixture',content:[{type:'text',text:'done'}]}}]}
 ${method}
 })`,context)
 return {run:()=>new C().dshKeepalive({expectedReply:'OK',maxCostUsd:.15,controller:new AbortController()}),stats:()=>({closed,spawned,listeners}),options:()=>queryOptions}
}
test('managed keepalive retains main native-tool policy without executing tools',async()=>{const f=fixture({managed:true});await f.run();const options=f.options();assert.deepEqual(options.disallowedTools,['Agent','Task','Workflow','ScheduleWakeup']);assert.equal(options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,'1');assert.equal(options.env.CLAUDE_CODE_MAX_RETRIES,'0');assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,'8');assert.equal((await options.canUseTool('Bash',{})).behavior,'deny');assert.equal(options.forkSession,true);assert.equal(options.persistSession,false)})
test('unmanaged keepalive does not acquire managed native-tool restrictions',async()=>{const f=fixture();await f.run();assert.equal(f.options().disallowedTools,undefined);assert.equal(f.options().env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,undefined)})
test('custom keepalive spawn drains stderr and closes successful query',async()=>{const f=fixture({stderr:'irrelevant diagnostic'});assert.equal((await f.run()).replyMatchesExpected,true);assert.deepEqual(f.stats(),{closed:1,spawned:1,listeners:1})})
for(const [detail,expected] of [
 ['API Error: 400 invalid_request_error max_tokens must be at least 16','Claude keepalive token parameters rejected (400)'],
 ['API Error: 400 invalid_request_error invalid signature','Claude keepalive upstream rejected request (400)'],
 ['API Error: 429 rate limit','Claude keepalive upstream rate limited (429)'],
 ['API Error: 403 unauthorized','Claude keepalive authentication failed (401/403)'],
 ['API Error: 503','Claude keepalive upstream service unavailable (5xx)'],
 ['connect ECONNRESET','Claude keepalive network connection failed'],
 ['No conversation found with session id abc','Claude keepalive resume session not found'],
 ['process exited with code 1','Claude keepalive CLI exited unsuccessfully']
])test('safe keepalive classification: '+expected,async()=>{
 const secret='sk-private-fixture';const f=fixture({stderr:detail+' '+secret,error:new Error('Claude Code returned an error result: '+detail),result:{type:'result',is_error:true,subtype:'error_during_execution',errors:[detail+' '+secret]}})
 await assert.rejects(f.run(),e=>{assert.equal(e.message,expected);assert.ok(!e.message.includes(secret));assert.ok(rpc.includes(JSON.stringify(expected)));return true});assert.deepEqual(f.stats(),{closed:1,spawned:1,listeners:1})
})
test('SDK exit exception after an error result retains safe result diagnostic',async()=>{const f=fixture({error:new Error('Claude Code process exited with code 1'),result:{type:'result',is_error:true,subtype:'error_during_execution',errors:['API Error: 400 max_tokens invalid sk-private']}});await assert.rejects(f.run(),/token parameters rejected \(400\)/)})
test('budget error remains failure and is never retried',async()=>{const f=fixture({result:{type:'result',is_error:true,subtype:'error_max_budget_usd',errors:[]}});await assert.rejects(f.run(),/budget exceeded/);assert.equal(f.stats().spawned,1)})
