import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dshPreheatClaude } from '../backend/plugins/claude-code/plugin.mjs'

// Opt-in real bundled SDK/CLI, keyless loopback-only model endpoint. No Host restart.
test('real SDK/CLI preheat sends exactly one 8-token low-effort no-cache hello request', {skip:!process.env.DSH_TEST_CLAUDE_EXECUTABLE,timeout:70000}, async()=>{
 const executable=process.env.DSH_TEST_CLAUDE_EXECUTABLE
 assert.ok(path.isAbsolute(executable))
 const root=await mkdtemp(path.join(tmpdir(),'dsh-preheat-wire-'))
 const config=path.join(root,'config');await mkdir(config)
 const parent=JSON.stringify(process.env),bodies=[],headers=[]
 const api=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c)
  const body=JSON.parse(Buffer.concat(chunks).toString()||'{}')
  if(req.url.includes('count_tokens')){res.end('{"input_tokens":20}');return}
  if(!req.url.includes('/messages')){res.end('{}');return}
  bodies.push(body);headers.push(req.headers)
  const message={id:'preheat-fixture',type:'message',role:'assistant',model:'claude-haiku-fixture',content:[{type:'text',text:'hello'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:20,output_tokens:1}}
  if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(message));return}
  res.setHeader('content-type','text/event-stream')
  const emit=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
  emit('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null}})
  emit('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}})
  emit('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'hello'}})
  emit('content_block_stop',{type:'content_block_stop',index:0})
  emit('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}})
  emit('message_stop',{type:'message_stop'});res.end()
 })
 await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve))
 const env={...process.env,CODEXHOST_CLAUDE_COMMAND:executable,ANTHROPIC_BASE_URL:`http://127.0.0.1:${api.address().port}`,ANTHROPIC_API_KEY:'fixture-only',CLAUDE_CONFIG_DIR:config,DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',NO_PROXY:'127.0.0.1,localhost',ENABLE_PROMPT_CACHING_1H:'1'}
 for(const key of ['ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_CUSTOM_HEADERS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'])env[key]=undefined
 try{
  const before=JSON.stringify(env)
  const result=await dshPreheatClaude(env,{controller:new AbortController(),timeoutMs:60000})
  const evidence={result,bodies,betas:headers.map(h=>h['anthropic-beta']),realUpstreamRequests:0}
  await writeFile(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2))
  console.log('PREHEAT_WIRE_EVIDENCE',path.join(root,'evidence.json'))
  assert.equal(JSON.stringify(env),before);assert.equal(JSON.stringify(process.env),parent)
  assert.equal(bodies.length,1,'No automatic title, retry or extra model request')
  const body=bodies[0];assert.match(body.model,/^claude-haiku-/);assert.equal(body.max_tokens,8);assert.equal(body.output_config?.effort,'low')
  assert.equal(body.tools?.length??0,0);assert.ok(!JSON.stringify(body).includes('cache_control'))
  // CLI adds its own identity/Environment system content even with systemPrompt:''.
  // Assert one user prompt, not the false claim that native wire has no system content.
  const users=body.messages.filter(message=>message.role==='user');assert.equal(users.length,1)
  const text=typeof users[0].content==='string'?users[0].content:users[0].content.filter(c=>c.type==='text').map(c=>c.text).join('')
  assert.equal(text,'Reply exactly hello.')
  assert.ok(headers[0]['anthropic-beta']?.includes('claude-code-20250219'))
  assert.equal(result.selectedModel,'haiku');assert.equal(result.replyMatchesHello,true);assert.equal(result.model,'claude-haiku-fixture');assert.equal(result.detached,true);assert.equal(result.usage.output_tokens,1)
 }finally{api.closeAllConnections();await new Promise(resolve=>api.close(resolve))}
})
