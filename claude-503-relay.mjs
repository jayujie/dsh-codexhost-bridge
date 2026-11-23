import * as dshRelayHttp from 'node:http';
import * as dshRelayHttps from 'node:https';
import * as dshRelayTls from 'node:tls';
import { randomBytes as dshRelayRandomBytes } from 'node:crypto';
import { setTimeout as dshRelaySleep } from 'node:timers/promises';
import { readFileSync as dshRelayReadFileSync } from 'node:fs';
import { homedir as dshRelayHomedir } from 'node:os';
import { join as dshRelayJoin } from 'node:path';
import * as dshRelayZlib from 'node:zlib';

// The CLI applies settings-file "env" over its process environment (local > project >
// user), so a relay URL passed only as a process variable is silently ignored when the
// user's settings.json names the gateway (verified CLI 2.1.325, 2026-11-22). Resolve the
// gateway the CLI would really use, and hand the relay URL back as flag settings, which
// outrank every settings file.
export function dshClaudeEffectiveBaseUrl(environment, cwd) {
  const configDir = environment.CLAUDE_CONFIG_DIR || dshRelayJoin(dshRelayHomedir(), '.claude');
  const files = [...(cwd ? [dshRelayJoin(cwd, '.claude', 'settings.local.json'), dshRelayJoin(cwd, '.claude', 'settings.json')] : []), dshRelayJoin(configDir, 'settings.json')];
  for (const file of files) {
    let value;
    try { value = JSON.parse(dshRelayReadFileSync(file, 'utf8'))?.env?.ANTHROPIC_BASE_URL; } catch { continue; }
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return environment.ANTHROPIC_BASE_URL;
}

export function dshClaudeRelayEnvironment(relay, environment) {
  const noProxy = '127.0.0.1,localhost,' + (environment.NO_PROXY || environment.no_proxy || '');
  return { ANTHROPIC_BASE_URL: relay.baseUrl, CLAUDE_CODE_MAX_RETRIES: '0', API_TIMEOUT_MS: '1801000', CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: '1800000', API_FORCE_IDLE_TIMEOUT: '0', NO_PROXY: noProxy, no_proxy: noProxy };
}

// A quota guard is not a transient outage: forward it at once so the Turn fails with
// its reset time instead of waiting through three pointless relay retries. Applies to
// every retryable status, because a gateway may report quota as 429 as well as 503.
const DSH_RELAY_NO_RETRY_QUOTA = /五小时(?:用量|额度)|quota|usage limit/iu;

// Statuses whose rejection arrives before any response byte reaches the CLI, so a retry
// is invisible to it. 503 keeps its long outage delay. 502/504/529 are gateway or
// upstream hiccups: short jittered backoff. 429 is retried only when the gateway names a
// short wait (Retry-After <= 60 s); a bare 429 is forwarded so the Turn reports it.
// HTTP 500 and other 4xx are never repeated: they are usually deterministic.
const DSH_RELAY_TRANSIENT_STATUS = new Set([502, 504, 529]);
const DSH_RELAY_TRANSIENT_BACKOFF_MS = [2000, 5000, 15000];
const DSH_RELAY_MAX_RETRY_AFTER_MS = 60000;
// Bounded by the Anthropic Messages API request limit; larger bodies cannot succeed upstream.
const DSH_RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024;

// Returns the wait before the next attempt, or null when this status is not retried.
export function dshRelayRetryDelayMs(status, headers, attempt, { retryDelayMs, backoffMs = DSH_RELAY_TRANSIENT_BACKOFF_MS, random = Math.random }) {
  if (status === 503) return retryDelayMs;
  const jitter = value => Math.round(value * (0.8 + 0.4 * random()));
  if (status === 429) {
    const seconds = Number(headers['retry-after']);
    if (headers['retry-after'] === undefined || !Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > DSH_RELAY_MAX_RETRY_AFTER_MS) return null;
    return jitter(Math.max(1000, seconds * 1000));
  }
  if (DSH_RELAY_TRANSIENT_STATUS.has(status)) return jitter(backoffMs[Math.min(attempt, backoffMs.length - 1)]);
  return null;
}

// Decode only for the quota check; the CLI still receives the original encoded bytes.
function dshRelayBodyText(body, encoding) {
  try {
    const kind = String(encoding || '').trim().toLowerCase();
    const plain = kind === 'gzip' ? dshRelayZlib.gunzipSync(body) : kind === 'br' ? dshRelayZlib.brotliDecompressSync(body) : kind === 'deflate' ? dshRelayZlib.inflateSync(body) : body;
    return plain.toString('utf8');
  } catch { return ''; }
}

// Keep native transport for configurations needing CLI-specific TLS/provider behavior.
export function dshClaude503RelaySupported(environment) {
  const proxy = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy || environment.ALL_PROXY || environment.all_proxy;
  if (proxy && !/^https?:\/\//i.test(proxy)) return false;
  return !['CLAUDE_CODE_CLIENT_CERT','CLAUDE_CODE_CLIENT_KEY','CLAUDE_CODE_CLIENT_KEY_PASSPHRASE','CLAUDE_CODE_CERT_STORE','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','NODE_TLS_REJECT_UNAUTHORIZED','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].some(key=>environment[key]);
}

// Per-transport HTTP relay: retries only complete HTTP 503 rejections, never SSE,
// a Turn, input queue or tool. No credentials, bodies or URLs are logged/persisted.
export async function dshCreateClaude503Relay(environment, options = {}) {
  const base = new URL(options.baseUrl ?? environment.ANTHROPIC_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Invalid Claude API base URL');
  const retryDelayMs = options.retryDelayMs ?? 60000;
  const maxBodyBytes = options.maxBodyBytes ?? DSH_RELAY_MAX_BODY_BYTES;
  const maxRetries = 3;
  const originalApiTimeout = Number(environment.API_TIMEOUT_MS);
  const headerTimeoutMs = Math.min(1740000,Number.isFinite(originalApiTimeout) && originalApiTimeout > 0 ? originalApiTimeout : 600000);
  const relayBudgetMs = Math.min(1740000,headerTimeoutMs + retryDelayMs * maxRetries);
  const sleep = options.sleep ?? ((ms, signal) => dshRelaySleep(ms, undefined, { signal }));
  const log = options.log ?? (s => process.stderr.write(s));
  const prefix = '/' + dshRelayRandomBytes(24).toString('hex');
  const active = new Set();
  let closed = false;
  const proxyRaw = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy || environment.ALL_PROXY || environment.all_proxy;
  const noProxy = (environment.NO_PROXY || environment.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean);
  const bypass = noProxy.some(value => value === '*' || base.hostname === value || base.host === value || (value.startsWith('.') && base.hostname.endsWith(value)));
  const proxy = proxyRaw && !bypass ? new URL(proxyRaw) : null;
  if (proxy && !['http:', 'https:'].includes(proxy.protocol)) throw Error('Claude retry relay requires an HTTP(S) proxy');
  // Route through the same configured HTTP(S) proxy, retaining TLS validation/SNI.
  function agentFor(signal) {
    if (!proxy) return undefined;
    const agent = base.protocol === 'https:' ? new dshRelayHttps.Agent({keepAlive:false}) : new dshRelayHttp.Agent({keepAlive:false});
    agent.createConnection = (opts, callback) => {
      let done = false;
      const finish = (error, socket) => { if (done) return; done = true; callback(error, socket); };
      const connect = (proxy.protocol === 'https:' ? dshRelayHttps : dshRelayHttp).request(proxy, {
        method:'CONNECT', path:base.hostname + ':' + (base.port || (base.protocol === 'https:' ? 443 : 80)), signal,
        headers:proxy.username ? {'proxy-authorization':'Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64')} : {}
      });
      connect.setTimeout(30000, () => connect.destroy(Error('Claude relay proxy timeout')));
      connect.once('error', finish);
      connect.once('connect', (res, socket, head) => {
        if (res.statusCode !== 200) {socket.destroy();finish(Error('Claude relay proxy CONNECT failed'));return;}
        if (head.length) socket.unshift(head);
        if (base.protocol === 'http:') {finish(null,socket);return;}
        const secure = dshRelayTls.connect({socket,servername:base.hostname,rejectUnauthorized:true,ALPNProtocols:['http/1.1']});
        const abort = () => secure.destroy();signal.addEventListener('abort',abort,{once:true});secure.once('close',()=>signal.removeEventListener('abort',abort));
        secure.setTimeout(30000,()=>secure.destroy(Error('Claude relay TLS timeout')));
        secure.once('secureConnect',()=>{secure.setTimeout(0);finish(null,secure)});secure.once('error',finish);
      });connect.end();
    };
    return agent;
  }
  const server = dshRelayHttp.createServer(async (req, res) => {
    if (closed || !req.url?.startsWith(prefix + '/')) {res.writeHead(404);res.end();return;}
    const controller = new AbortController(), signal = controller.signal;
    const deadlineAt = Date.now() + relayBudgetMs;
    active.add(controller);
    const cancel = () => controller.abort();
    res.once('close', cancel); req.once('aborted',cancel);
    try {
      const parts = []; let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > maxBodyBytes) {
          // Answer cleanly instead of dropping the connection, which the CLI would retry blindly.
          res.writeHead(413, {'content-type':'application/json', connection:'close'});
          res.end(JSON.stringify({type:'error',error:{type:'request_too_large',message:'Request exceeds the relay body limit'}}), () => req.destroy());
          return;
        }
        parts.push(part);
      }
      const body = Buffer.concat(parts, bytes);
      const suffix = req.url.slice(prefix.length);
      // Concatenate instead of resolving URL: preserve the configured gateway path.
      const target = new URL(base.href.replace(/\/$/,'') + suffix);
      const headers = {...req.headers, host:base.host};
      for (const k of ['connection','proxy-connection','keep-alive','transfer-encoding','upgrade']) delete headers[k];
      headers['content-length'] = String(body.length);
      const retryable = req.method === 'POST' && target.pathname === base.pathname.replace(/\/$/,'') + '/v1/messages';
      let networkRetries = 0;
      for (let attempt = 0; ; ) {
        if (signal.aborted) break;
        const agent = agentFor(signal);
        let upstream;
        try {
          upstream = await new Promise((resolve,reject) => {
            const outgoing = (base.protocol === 'https:' ? dshRelayHttps : dshRelayHttp).request(target,{method:req.method,headers,agent,signal},resolve);
            const headerDeadline = setTimeout(()=>outgoing.destroy(Error('Claude relay headers timeout')),Math.max(1,Math.min(headerTimeoutMs,deadlineAt-Date.now())));
            outgoing.once('response',()=>clearTimeout(headerDeadline));outgoing.once('error',error=>{clearTimeout(headerDeadline);reject(error)});outgoing.end(body);
          });
          let rejection = null;
          const delay = retryable ? dshRelayRetryDelayMs(upstream.statusCode, upstream.headers, attempt, {retryDelayMs, backoffMs:options.transientBackoffMs, random:options.random}) : null;
          if (delay !== null) {
            // A rejection body is small; read it (bounded) before deciding.
            const chunks = []; let size = 0;
            for await (const chunk of upstream) { size += chunk.length; if (size > 65536) break; chunks.push(chunk); }
            rejection = Buffer.concat(chunks);
          }
          if (rejection && DSH_RELAY_NO_RETRY_QUOTA.test(dshRelayBodyText(rejection, upstream.headers['content-encoding']))) log(`[DSH Claude] HTTP ${upstream.statusCode} quota guard; not retried\n`);
          else if (rejection && attempt < maxRetries && Date.now() + delay < deadlineAt) {
            // No response bytes have reached the CLI. Discard the rejection, not an SSE stream.
            upstream.destroy();agent?.destroy();
            log(`[DSH Claude] HTTP ${upstream.statusCode}; retry ${attempt+1}/3 in ${delay}ms\n`);
            attempt++;
            await sleep(delay,signal);continue;
          }
          const responseHeaders = {...upstream.headers};
          for (const k of ['connection','keep-alive','transfer-encoding','upgrade']) delete responseHeaders[k];
          if (rejection) { responseHeaders['content-length'] = String(rejection.length); res.writeHead(upstream.statusCode, responseHeaders); res.end(rejection); }
          else { res.writeHead(upstream.statusCode, responseHeaders); upstream.on('error',()=>res.destroy()); upstream.pipe(res); }
          await new Promise(resolve=>{res.once('finish',resolve);res.once('close',resolve)});
          break;
        } catch (error) {
          // Preserve the previous two bounded connection-error retries, but never
          // retry after headers/SSE have been forwarded or after cancellation.
          if (!upstream && !signal.aborted && retryable && ['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','EAI_AGAIN'].includes(error.code) && networkRetries < 2) {
            networkRetries++;
            log(`[DSH Claude] connection retry ${networkRetries}/2\n`);
            await sleep(500 * networkRetries,signal);continue;
          }
          throw error;
        } finally {upstream?.destroy();agent?.destroy();}
      }
    } catch { if (!res.destroyed) res.destroy(); }
    finally {controller.abort();active.delete(controller);res.removeListener('close',cancel);req.removeListener('aborted',cancel);}
  });
  server.requestTimeout = 0; server.timeout = 0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return {
    baseUrl:`http://127.0.0.1:${server.address().port}${prefix}`,
    cancel() {for (const c of active) c.abort();},
    async close() {closed=true;for(const c of active)c.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  };
}
