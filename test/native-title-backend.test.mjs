import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
const sdk=await readFile(new URL('../claude-title-sdk.txt',import.meta.url),'utf8')
const rpc=await readFile(new URL('../title-rpc-backend.txt',import.meta.url),'utf8')
const valid=()=>({description:'会话导入与缓存隔离',model:'claude-haiku-5-5',maxOutputTokens:512,timeoutMs:1000,maxCostUsd:0.05,cwd:'D:/fixture',controller:new AbortController()})
function titleFixture(result={response:{title:'会话导入'}}){
 let captured,closed=0,calls=[]
 const scope={Buffer,Promise,Set,setTimeout,clearTimeout,resolveClaudeCodeExecutable:()=>'/fixture/claude',dshCollaborationChildEnvironment:env=>({...env,DSH_COLLABORATION_TOKEN:undefined,DSH_WEB_BRIDGE_TOKEN:undefined}),withNodeRuntimeOnPath:env=>env,SESSION_ENTRYPOINT:'codexhost-sdk',CLIENT_APP:'codexhost-claude-code-adapter/0.0.0',k5t:options=>{captured=options;return{async initializationResult(){},async request(input){calls.push(input);return result},close(){closed++}}}}
 const fn=vm.runInNewContext(sdk.replace(/^export \{.*\};$/m,'')+'\ndshGenerateNativeTitle',scope)
 return{fn,get captured(){return captured},get closed(){return closed},calls}
}
test('title child adds its beta and disables only its own caching/output while retaining actual identity',async()=>{
 const f=titleFixture(),environment={ENABLE_PROMPT_CACHING_1H:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'128000',ANTHROPIC_BETAS:'existing-beta',ANTHROPIC_AUTH_TOKEN:'fixture-only',DSH_COLLABORATION_TOKEN:'private-fixture'},before={...environment}
 const result=await f.fn(environment,valid());assert.equal(result.title,'会话导入');assert.equal(result.detached,true);assert.equal(result.cachePolicy,'disabled-client')
 assert.deepEqual(environment,before);const options=f.captured.options
 assert.equal(options.env.DISABLE_PROMPT_CACHING,'1');assert.equal(options.env.ENABLE_PROMPT_CACHING_1H,'0');assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,'512');assert.equal(options.env.CLAUDE_CODE_MAX_RETRIES,'0');assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT,'codexhost-sdk');assert.equal(options.env.DSH_COLLABORATION_TOKEN,undefined)
 assert.equal(options.settings.env.DISABLE_PROMPT_CACHING,'1');assert.ok(options.env.ANTHROPIC_BETAS.includes('existing-beta'));assert.ok(options.env.ANTHROPIC_BETAS.includes('claude-code-20250219'));assert.equal(options.persistSession,false);assert.equal(options.resume,undefined);assert.equal(options.forkSession,undefined);assert.equal(options.strictMcpConfig,true);assert.equal(options.tools.length,0)
 assert.equal((await options.canUseTool()).behavior,'deny');assert.equal(f.calls.length,1);assert.equal(f.calls[0].subtype,'generate_session_title');assert.equal(f.calls[0].persist,false);assert.equal(f.closed,1);assert.equal((await f.captured.prompt.next()).done,true)
})
test('title child validates bounds and abort before allocating an SDK query',async()=>{
 for(const patch of [{maxOutputTokens:127},{maxOutputTokens:4097},{timeoutMs:999},{model:'other-model'},{description:' '},{maxCostUsd:2}]){const f=titleFixture();await assert.rejects(f.fn({}, {...valid(),...patch}),/Invalid native title/);assert.equal(f.captured,undefined)}
 const f=titleFixture(),input=valid();input.controller.abort();await assert.rejects(f.fn({},input));assert.equal(f.captured,undefined)
})
test('null or oversized native output closes the child without returning a partial title',async()=>{
 for(const title of [null,'','x'.repeat(513)]){const f=titleFixture({response:{title}});await assert.rejects(f.fn({},valid()),/did not finish/);assert.equal(f.closed,1)}
})
function rpcFixture(session={async dshGenerateTitle(){return{title:'标题',detached:true,cachePolicy:'disabled-client'}}}){
 const writes=[],diagnostics=[];let resolved=0
 const resolution={kind:'external',thread:{harnessId:'claude-code',session,running:false,activeTurnId:null}}
 const scope={Map,AbortController,resolution,writes,diagnostics,markResolved:()=>resolved++,rpcError:(request,code,message)=>({id:request.id,error:{code,message}}),rpcEnvelope:(request,value)=>({id:request.id,...value})}
 const host=vm.runInNewContext(`new class { #dshTitles=new Map(); #writer={json:async value=>writes.push(value)}; async #resolveExternalThread(){markResolved();return resolution}; #diagnose(value){diagnostics.push(value)}; get size(){return this.#dshTitles.size}; async run(request){${rpc}} }`,scope)
 return{host,resolution,writes,diagnostics,get resolved(){return resolved}}
}
test('private title RPC returns only after successful scoped execution and releases its owner',async()=>{
 const f=rpcFixture();await f.host.run({id:1,method:'dsh/claude/title/generate',params:{threadId:'t',operationId:'op'}});assert.equal(f.writes[0].result.title,'标题');assert.equal(f.host.size,0)
})
test('private title RPC refuses an invalid identity or a busy/non-Claude owner',async()=>{
 const f=rpcFixture();await f.host.run({id:1,method:'dsh/claude/title/generate',params:{threadId:'t',operationId:''}});assert.equal(f.writes[0].error.code,-32602);assert.equal(f.resolved,0)
 for(const patch of [{running:true},{harnessId:'codex'}]){const x=rpcFixture();Object.assign(x.resolution.thread,patch);await x.host.run({id:2,method:'dsh/claude/title/generate',params:{threadId:'t',operationId:'op'}});assert.equal(x.writes[0].error.code,-32080);assert.equal(x.host.size,0)}
})
test('title cancellation aborts only the exact active operation and clears its map entry',async()=>{
 const started=Promise.withResolvers();let signal
 const f=rpcFixture({dshGenerateTitle({controller}){signal=controller.signal;started.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}})
 const run=f.host.run({id:1,method:'dsh/claude/title/generate',params:{threadId:'t',operationId:'op'}});await started.promise
 await f.host.run({id:2,method:'dsh/claude/title/cancel',params:{threadId:'t',operationId:'other'}});assert.equal(signal.aborted,false)
 await f.host.run({id:3,method:'dsh/claude/title/cancel',params:{threadId:'t',operationId:'op'}});await run;assert.equal(signal.aborted,true);assert.equal(f.host.size,0);assert.ok(f.writes.some(value=>value.error?.code===-32091))
})
