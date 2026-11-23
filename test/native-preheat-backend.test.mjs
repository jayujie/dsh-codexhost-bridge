import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const sdk = await readFile(new URL('../claude-preheat-sdk.txt', import.meta.url), 'utf8')
const title = await readFile(new URL('../claude-title-sdk.txt', import.meta.url), 'utf8')
const rpc = await readFile(new URL('../preheat-rpc-backend.txt', import.meta.url), 'utf8')
const id = '12345678-1234-4234-8234-123456789abc'
function fixture(messages = [{type:'assistant',message:{model:'claude-fixture-haiku'}},{type:'result',subtype:'success',result:'hello',usage:{input_tokens:12,output_tokens:1,cache_read_input_tokens:0,secret:'no'}}], overrides = {}) {
 let captured,closed=0,removed=[]
 const scope={withUserShellEnvironment:async env=>env,process:{env:{}},Buffer,Promise,Set,setTimeout,clearTimeout, dshPreheatMkdtemp:async()=> 'C:/temp/dsh-claude-preheat-fixture',dshPreheatRm:async (...args)=>removed.push(args),dshPreheatTmpdir:()=> 'C:/temp',dshPreheatJoin:(...x)=>x.join('/'),resolveClaudeCodeExecutable:()=> 'C:/claude',dshCollaborationChildEnvironment:env=>({...env,DSH_COLLABORATION_TOKEN:undefined}),withNodeRuntimeOnPath:env=>env,SESSION_ENTRYPOINT:'codexhost-sdk',CLIENT_APP:'fixture',k5t:value=>{captured=value;return{async *[Symbol.asyncIterator](){yield* messages},close(){closed++}}}}
 Object.assign(scope, overrides)
 const fn=vm.runInNewContext(title.replace(/^export .*$/gm,'')+'\n'+sdk.replace(/^import .*;$/gm,'').replace(/^export .*$/gm,'')+'\ndshPreheatClaude',scope)
 return{fn,get captured(){return captured},get closed(){return closed},removed}
}
test('preheat uses one fixed isolated SDK query, retaining account/proxy but not parent mutation',async()=>{
 const f=fixture(),env={ENABLE_PROMPT_CACHING_1H:'1',ANTHROPIC_AUTH_TOKEN:'fixture',HTTPS_PROXY:'fixture-proxy',DSH_COLLABORATION_TOKEN:'private'},before={...env}
 const value=await f.fn(env,{controller:new AbortController()});assert.deepEqual(env,before)
 assert.equal(value.selectedModel,'haiku');assert.equal(value.model,'claude-fixture-haiku');assert.equal(value.replyMatchesHello,true);assert.equal(value.detached,true);assert.equal(value.cachePolicy,'disabled-client');assert.equal(value.usage.input_tokens,12);assert.equal(value.usage.secret,undefined)
 const {prompt,options:o}=f.captured;assert.equal(prompt,'Reply exactly hello.');assert.equal(o.model,'haiku');assert.equal(o.effort,'low');assert.equal(o.persistSession,false)
 for(const key of ['resume','forkSession','continue','fallbackModel'])assert.equal(o[key],undefined)
 assert.equal(o.cwd,'C:/temp/dsh-claude-preheat-fixture');assert.equal(o.settingSources.join(','),'user');assert.equal(o.settings.disableAllHooks,true);assert.equal(o.tools.length,0);assert.equal(Object.keys(o.mcpServers).length,0);assert.equal(o.strictMcpConfig,true);assert.equal((await o.canUseTool()).behavior,'deny')
 assert.equal(o.maxTurns,1);assert.equal(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,'8');assert.equal(o.env.CLAUDE_CODE_MAX_RETRIES,'0');assert.equal(o.env.DISABLE_PROMPT_CACHING,'1');assert.equal(o.env.ENABLE_PROMPT_CACHING_1H,'0');assert.equal(o.env.HTTPS_PROXY,'fixture-proxy');assert.equal(o.env.ANTHROPIC_AUTH_TOKEN,'fixture');assert.equal(o.env.DSH_COLLABORATION_TOKEN,undefined);assert.ok(o.env.ANTHROPIC_BETAS.includes('claude-code-20250219'));assert.equal(f.closed,1);assert.equal(f.removed.length,1)
})
test('nonmatching reply is not falsely reported as hello and unknown actual model stays alias',async()=>{
 const f=fixture([{type:'result',subtype:'success',result:'Hello.',usage:{input_tokens:-1,output_tokens:NaN}}]);const r=await f.fn({},{controller:new AbortController()});assert.equal(r.replyMatchesHello,false);assert.equal(r.model,'haiku');assert.equal(r.usage,undefined)
})
test('failed or missing terminal result closes SDK and removes only owned neutral cwd',async()=>{
 for(const messages of [[],[{type:'result',subtype:'error_max_turns',result:'hello'}]]) { const f=fixture(messages);await assert.rejects(f.fn({},{controller:new AbortController()}),/did not finish/);assert.equal(f.closed,1);assert.equal(f.removed[0][0],'C:/temp/dsh-claude-preheat-fixture') }
})
test('invalid timeout and pre-cancel allocate no query',async()=>{
 for(const timeoutMs of [999,60001,1.2]){const f=fixture();await assert.rejects(f.fn({},{timeoutMs,controller:new AbortController()}),/Invalid/);assert.equal(f.captured,undefined)}
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.fn({},{controller}));assert.equal(f.captured,undefined)
})
test('backend deadline aborts and cleans a blocked SDK query without client cancellation',async()=>{
 let expire,cleared=false;const started=Promise.withResolvers(),controller=new AbortController()
 const messages={async *[Symbol.asyncIterator](){started.resolve();await new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}))}}
 const f=fixture(messages,{setTimeout:fn=>{expire=fn;return 1},clearTimeout:()=>{cleared=true}})
 const task=f.fn({},{controller,timeoutMs:1000});await started.promise;expire();await assert.rejects(task);assert.equal(controller.signal.aborted,true);assert.equal(cleared,true);assert.equal(f.closed,1);assert.equal(f.removed.length,1)
})
test('restores the SDK synchronous global version marker without changing other environment',async()=>{
 const process={env:{CLAUDE_AGENT_SDK_VERSION:'original',HTTPS_PROXY:'fixture'}}
 const f=fixture(undefined,{process,k5t:()=>{process.env.CLAUDE_AGENT_SDK_VERSION='changed';return{async *[Symbol.asyncIterator](){yield{type:'result',subtype:'success',result:'hello'}},close(){}}}})
 await f.fn({},{controller:new AbortController()});assert.deepEqual(process.env,{CLAUDE_AGENT_SDK_VERSION:'original',HTTPS_PROXY:'fixture'})
})
function rpcFixture(execute=async()=>({selectedModel:'haiku',model:'haiku',replyMatchesHello:true,detached:true,cachePolicy:'disabled-client'})) {
 const writes=[],diagnostics=[]
 const scope={Map,AbortController,process:{env:{}},execute,writes,diagnostics,rpcError:(r,code,message)=>({id:r.id,error:{code,message}}),rpcEnvelope:(r,v)=>({id:r.id,...v})}
 // Only substitute the dynamic module loading seam; the dispatcher itself is unmodified.
 const body=rpc.replace('const { dshPreheatClaude } = await import(new URL("./plugins/claude-code/plugin.mjs", import.meta.url).href);','const dshPreheatClaude = execute;')
 const host=vm.runInNewContext(`new class { #dshPreheats=new Map(); #desktopInputEnded=false; #pluginLoadAbort=new AbortController(); #options={environment:{}}; #writer={json:async value=>writes.push(value)}; #diagnose(value){diagnostics.push(value)}; get size(){return this.#dshPreheats.size}; stop(){this.#desktopInputEnded=true;for(const c of this.#dshPreheats.values())c.abort()}; async run(request){${body}} }`,scope)
 return{host,writes,diagnostics}
}
const request=(method='dsh/claude/preheat',operationId=id,extra={})=>({id:1,method,params:{operationId,...extra}})
test('private RPC is account scoped, validates UUID/timeout and emits safe fixed errors',async()=>{
 const f=rpcFixture();await f.host.run(request());assert.equal(f.writes[0].result.selectedModel,'haiku');assert.equal(f.host.size,0)
 for(const r of [request(undefined,'bad'),request(undefined,id,{timeoutMs:60001})]){await f.host.run(r);assert.equal(f.writes.at(-1).error.code,-32602)}
 const x=rpcFixture(async()=>{throw new Error('Bearer secret-token C:/secret')});await x.host.run(request());assert.equal(x.writes[0].error.message,'Claude preheat transport failed');assert.ok(!JSON.stringify(x.diagnostics).includes('secret'))
})
test('exact cancellation bypasses active request, rejects concurrent probe and releases operation',async()=>{
 const started=Promise.withResolvers();let signal
 const f=rpcFixture(async(_,{controller})=>{signal=controller.signal;started.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
 const pending=f.host.run(request());await started.promise
 await f.host.run(request());assert.equal(f.writes.at(-1).error.code,-32080)
 await f.host.run(request('dsh/claude/preheat/cancel','22345678-1234-4234-8234-123456789abc'));assert.equal(signal.aborted,false)
 await f.host.run(request('dsh/claude/preheat/cancel',id.toUpperCase()));await pending;assert.equal(signal.aborted,true);assert.equal(f.host.size,0);assert.ok(f.writes.some(x=>x.error?.message==='Claude preheat cancelled or timed out'))
})
test('shutdown aborts pending work and rejects subsequent preheat',async()=>{
 const started=Promise.withResolvers();const f=rpcFixture(async(_,{controller})=>{started.resolve();return new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}))});const pending=f.host.run(request());await started.promise;f.host.stop();await pending;await f.host.run(request());assert.equal(f.writes.at(-1).error.code,-32080);assert.equal(f.host.size,0)
})
test('build wires dynamic exported executor and abort-before-drain without touching title/keepalive snippets',async()=>{
 const build=await readFile(new URL('../build-backend.mjs',import.meta.url),'utf8');assert.ok(build.includes('preheat-rpc-backend.txt'));assert.ok(build.includes('claude-preheat-sdk.txt'));assert.ok(build.includes('for (const controller of this.#dshPreheats.values()) controller.abort();'));assert.ok(rpc.includes('./plugins/claude-code/plugin.mjs'))
})
