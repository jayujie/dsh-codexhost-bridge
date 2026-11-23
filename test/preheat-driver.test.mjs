import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSessionDriver } from '../native-session-driver.mjs'
function fixture(request) {
 const calls=[]
 const peer={closed:new Promise(()=>{}),subscribe:()=>()=>{},close(){},request:async(method,params)=>{calls.push({method,params});return request?.(method,params)??{detached:true}}}
 const ctx={agents:{list:()=>[]}}
 return {driver:new NativeSessionDriver(ctx,{}, {connect:async()=>peer,cancelTimeoutMs:20}),calls}
}
test('账号预热不需要Agent/Thread，不发送turn/start或会话内容',async()=>{
 const f=fixture();const response=await f.driver.preheat({signal:new AbortController().signal});assert.equal(response.detached,true)
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'dsh/claude/preheat');assert.deepEqual(Object.keys(f.calls[0].params),['operationId']);assert.match(f.calls[0].params.operationId,/^[a-f0-9-]{36}$/)
 await f.driver.dispose()
})
test('预取消不发RPC，执行中取消精确operationId且不重试',async()=>{
 const f=fixture();const before=new AbortController();before.abort();await assert.rejects(f.driver.preheat({signal:before.signal}));assert.equal(f.calls.length,0)
 let finish;const active=fixture(method=>method==='dsh/claude/preheat'?new Promise(resolve=>finish=resolve):{})
 const controller=new AbortController(),run=active.driver.preheat({signal:controller.signal});await new Promise(r=>setImmediate(r));controller.abort();finish({detached:true});await assert.rejects(run)
 assert.deepEqual(active.calls.map(c=>c.method),['dsh/claude/preheat','dsh/claude/preheat/cancel']);assert.equal(active.calls[0].params.operationId,active.calls[1].params.operationId)
 await active.driver.dispose();await f.driver.dispose()
})
test('防止并发预热，卸载会取消并等待结算',async()=>{
 let finish;const f=fixture(method=>method==='dsh/claude/preheat'?new Promise(resolve=>finish=resolve):{})
 const run=f.driver.preheat({signal:new AbortController().signal});const rejected=assert.rejects(run);await new Promise(r=>setImmediate(r));await assert.rejects(f.driver.preheat({signal:new AbortController().signal}),/正在执行/)
 const disposing=f.driver.dispose();finish({detached:true});await rejected;await disposing
 assert.equal(f.calls.filter(c=>c.method==='dsh/claude/preheat').length,1);assert.equal(f.calls[1].method,'dsh/claude/preheat/cancel');assert.equal(f.driver.available(),false)
 await assert.rejects(f.driver.preheat({signal:new AbortController().signal}));assert.equal(f.calls.length,2)
})
