import * as dshAgyCollabFs from 'node:fs/promises';
import { createServer as dshAgyCollabCreateServer } from 'node:http';
import dshAgyCollabPath from 'node:path';
import { randomBytes as dshAgyCollabRandomBytes, timingSafeEqual as dshAgyCollabTimingSafeEqual } from 'node:crypto';
import { NATIVE_BACKGROUND_SCHEMA, nativeBackgroundOperation } from './native-background-bridge.mjs';

const DSH_AGY_PRIVATE_ENV_KEYS = new Set([
  'DSH_UNIFIED_WAKE',
  'DSH_COLLABORATION_URL',
  'DSH_COLLABORATION_TOKEN',
  'DSH_WEB_BRIDGE_URL',
  'DSH_WEB_BRIDGE_TOKEN',
]);

const DSH_AGY_COLLABORATION_TOOL = Object.freeze({
  name: 'dsh_collaboration',
  description: 'Use the current DSH subagent tree and shared task board. First call name="__list__", arguments={} to discover admitted tools, then invoke them. Never use the separate Host delegation CLI.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      arguments: { type: 'object', additionalProperties: true },
    },
    required: ['name', 'arguments'],
    additionalProperties: false,
  },
});

export const DSH_AGY_WAKE_MATCHER = '^(invoke_subagent|define_subagent|manage_subagents|swarm|run_workflow|schedule|send_message)$';

export const DSH_AGY_COLLAB_MCP_CLIENT = String.raw`
"use strict";
const http = require("node:http");
const readline = require("node:readline");

const endpoint = process.env.CODEXHOST_AGY_COLLAB_URL || "";
const token = process.env.CODEXHOST_AGY_COLLAB_TOKEN || "";
let tools = [];
try {
  tools = JSON.parse(process.env.CODEXHOST_AGY_COLLAB_TOOLS || "[]");
} catch {
  tools = [];
}

const FAILURE = {
  isError: true,
  content: [{ type: "text", text: "DSH collaboration failed or was denied. Do not automatically replay a task or message mutation." }],
};

let pending = 0;
let stdinClosed = false;
function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function callRelay(id, name, args) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(endpoint);
      if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.pathname !== "/collaboration" || target.username || target.password || !token) {
        resolve(FAILURE);
        return;
      }
    } catch {
      resolve(FAILURE);
      return;
    }
    const body = Buffer.from(JSON.stringify({ id: String(id), tool: name, arguments: args ?? {} }), "utf8");
    const req = http.request({
      hostname: "127.0.0.1",
      port: Number(target.port),
      path: "/collaboration",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "authorization": "Bearer " + token,
        "connection": "close",
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 131072) chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200 || size > 131072) {
          resolve(FAILURE);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(FAILURE);
        }
      });
    });
    req.on("error", () => resolve(FAILURE));
    req.end(body);
  });
}

process.stdin.on("end", () => {
  stdinClosed = true;
  maybeExit();
});
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dsh-collaboration", version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    return;
  }
  if (msg.method === "tools/call") {
    pending += 1;
    callRelay(msg.id, msg.params?.name, msg.params?.arguments)
      .then((result) => send({ jsonrpc: "2.0", id: msg.id, result }))
      .catch(() => send({ jsonrpc: "2.0", id: msg.id, result: FAILURE }))
      .finally(() => {
        pending -= 1;
        maybeExit();
      });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
});
`;

export const DSH_AGY_WAKE_HOOK_CLIENT = String.raw`
"use strict";
let raw = "";
let overflow = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (overflow) return;
  raw += chunk;
  if (Buffer.byteLength(raw) > 131072) {
    overflow = true;
    raw = "";
  }
});
process.stdin.on("end", () => {
  let toolName = "";
  if (!overflow) {
    try {
      const parsed = JSON.parse(raw);
      toolName = typeof parsed?.toolCall?.name === "string" ? parsed.toolCall.name : "";
    } catch {}
  }
  const reason = toolName === "send_message"
    ? 'Native send_message is disabled for this DSH-managed session. Use DSH MCP dsh_collaboration with name="send_message" to message DSH teammates. No native message was sent.'
    : 'Native autonomous/delegated work is disabled for this DSH-managed session. Use DSH MCP dsh_collaboration (first call name="__list__", arguments={}, then name="subagent" with engine="codex", "claude-code", "antigravity", or omit engine for native DSH) for delegation and dsh_background for background commands. This work was not started.';
  process.stdout.write(JSON.stringify({ decision: "deny", reason }));
});
`;

export function dshAntigravityChildEnvironment(environment) {
  if (!environment || typeof environment !== 'object') return {};
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !DSH_AGY_PRIVATE_ENV_KEYS.has(key)));
}

export function dshAntigravityCollaborationEnabled(environment) {
  if (!environment || typeof environment !== 'object') return false;
  if (typeof environment.DSH_COLLABORATION_TOKEN !== 'string' || !/^[a-f0-9]{64}$/i.test(environment.DSH_COLLABORATION_TOKEN)) return false;
  if (typeof environment.CODEXHOST_THREAD_ID !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,1024}$/u.test(environment.CODEXHOST_THREAD_ID)) return false;
  if (typeof environment.DSH_COLLABORATION_URL !== 'string') return false;
  try {
    const url = new URL(environment.DSH_COLLABORATION_URL);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1'
      && /^[1-9]\d{0,4}$/.test(url.port) && Number(url.port) <= 65535
      && url.pathname === '/collaboration' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function dshAntigravityUnifiedWakeDecision(toolName) {
  if (!['invoke_subagent', 'define_subagent', 'manage_subagents', 'swarm', 'run_workflow', 'schedule', 'send_message'].includes(toolName)) {
    return null;
  }
  const reason = toolName === 'send_message'
    ? 'Native send_message is disabled for this DSH-managed session. Use DSH MCP dsh_collaboration with name="send_message" to message DSH teammates. No native message was sent.'
    : 'Native autonomous/delegated work is disabled for this DSH-managed session. Use DSH MCP dsh_collaboration (first call name="__list__", arguments={}, then name="subagent" with engine="codex", "claude-code", "antigravity", or omit engine for native DSH) for delegation and dsh_background for background commands. This work was not started.';
  return { decision: 'deny', reason };
}

export function dshAntigravityCollaborationTools(environment) {
  if (!dshAntigravityCollaborationEnabled(environment)) return [];
  const tools = [DSH_AGY_COLLABORATION_TOOL];
  if (environment.DSH_UNIFIED_WAKE === '1') tools.push(NATIVE_BACKGROUND_SCHEMA);
  return tools;
}

export async function dshDispatchAntigravityCollaborationCall(environment, payload, fetchImpl = fetch) {
  const failure = {
    isError: true,
    content: [{ type: 'text', text: 'DSH collaboration failed or was denied. Do not automatically replay a task or message mutation.' }],
  };
  if (!dshAntigravityCollaborationEnabled(environment) || !payload || typeof payload !== 'object') return failure;
  const unified = environment.DSH_UNIFIED_WAKE === '1';
  const background = payload.tool === 'dsh_background' && unified;
  if (!background && payload.tool !== 'dsh_collaboration') return failure;
  let operation;
  try {
    const args = payload.arguments;
    operation = background ? nativeBackgroundOperation(args) : { name: args?.name, arguments: args?.arguments };
  } catch {
    return failure;
  }
  try {
    const response = await fetchImpl(environment.DSH_COLLABORATION_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + environment.DSH_COLLABORATION_TOKEN,
      },
      body: JSON.stringify({
        threadId: environment.CODEXHOST_THREAD_ID,
        id: (background ? 'antigravity-background:' : 'antigravity-mcp:') + String(payload.id ?? ''),
        ...operation,
        ...(background ? { channel: 'background' } : {}),
      }),
    });
    if (!response.ok) return failure;
    return await response.json();
  } catch {
    return failure;
  }
}

async function dshRemoveCollaborationArtifacts(directory) {
  const pluginDir = dshAgyCollabPath.join(directory, '.agents', 'plugins', 'dsh-collaboration');
  const mcpClient = dshAgyCollabPath.join(directory, 'dsh-collaboration-mcp.cjs');
  const wakeClient = dshAgyCollabPath.join(directory, 'wake-hook.cjs');
  await Promise.all([
    dshAgyCollabFs.rm(pluginDir, { recursive: true, force: true }).catch(() => {}),
    dshAgyCollabFs.rm(mcpClient, { force: true }).catch(() => {}),
    dshAgyCollabFs.rm(wakeClient, { force: true }).catch(() => {}),
  ]);
}

export async function dshSetupAntigravityCollaborationBridge({
  directory,
  sessionEnvironment,
  bridgeEnvironment,
  nodePath = process.execPath,
  platform = process.platform,
  fetchImpl = fetch,
}) {
  await dshRemoveCollaborationArtifacts(directory);
  if (!dshAntigravityCollaborationEnabled(sessionEnvironment)) {
    return { hooks: {}, stop() {}, async dispose() {} };
  }
  const unified = sessionEnvironment.DSH_UNIFIED_WAKE === '1';
  const tools = dshAntigravityCollaborationTools(sessionEnvironment);
  const relayToken = dshAgyCollabRandomBytes(32).toString('hex');
  let stopped = false;
  let disposal = null;

  const answer = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
    res.end(JSON.stringify(value));
  };

  const server = dshAgyCollabCreateServer({ maxHeaderSize: 8192, headersTimeout: 5000 }, async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from('Bearer ' + relayToken);
    if (stopped || req.method !== 'POST' || req.url !== '/collaboration' || req.headers.origin || supplied.length !== expected.length || !dshAgyCollabTimingSafeEqual(supplied, expected)) {
      answer(res, 403, {});
      req.resume();
      return;
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) {
          answer(res, 413, {});
          return;
        }
        chunks.push(chunk);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const result = await dshDispatchAntigravityCollaborationCall(sessionEnvironment, parsed, fetchImpl);
      answer(res, 200, result);
    } catch {
      answer(res, 200, {
        isError: true,
        content: [{ type: 'text', text: 'DSH collaboration failed or was denied. Do not automatically replay a task or message mutation.' }],
      });
    }
  });

  const stop = () => {
    stopped = true;
  };
  const dispose = () => {
    stop();
    disposal ??= (async () => {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await dshRemoveCollaborationArtifacts(directory);
    })();
    return disposal;
  };

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', stop);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Antigravity collaboration bridge did not bind');

    const pluginDir = dshAgyCollabPath.join(directory, '.agents', 'plugins', 'dsh-collaboration');
    const mcpClient = dshAgyCollabPath.join(directory, 'dsh-collaboration-mcp.cjs');
    await dshAgyCollabFs.mkdir(pluginDir, { recursive: true, mode: 448 });
    await dshAgyCollabFs.writeFile(mcpClient, DSH_AGY_COLLAB_MCP_CLIENT, { encoding: 'utf8', mode: 384 });
    await dshAgyCollabFs.writeFile(
      dshAgyCollabPath.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'dsh-collaboration', version: '1.0.0' }, null, 2) + '\n',
      { encoding: 'utf8', mode: 384 },
    );
    const eagerTools = Object.fromEntries(tools.map((tool) => [tool.name, { eager: true }]));
    await dshAgyCollabFs.writeFile(
      dshAgyCollabPath.join(pluginDir, 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          'dsh-collaboration': {
            command: nodePath,
            args: [mcpClient],
            env: {
              CODEXHOST_AGY_COLLAB_URL: `http://127.0.0.1:${address.port}/collaboration`,
              CODEXHOST_AGY_COLLAB_TOKEN: relayToken,
              CODEXHOST_AGY_COLLAB_TOOLS: JSON.stringify(tools),
            },
            tools: eagerTools,
          },
        },
      }, null, 2) + '\n',
      { encoding: 'utf8', mode: 384 },
    );

    const hooks = {};
    if (unified) {
      const wakeClient = dshAgyCollabPath.join(directory, 'wake-hook.cjs');
      await dshAgyCollabFs.writeFile(wakeClient, DSH_AGY_WAKE_HOOK_CLIENT, { encoding: 'utf8', mode: 384 });
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      if (bridgeEnvironment && typeof bridgeEnvironment === 'object') {
        bridgeEnvironment.CODEXHOST_AGY_WAKE_CLIENT = `"${wakeClient.replaceAll('\\', '/')}"`;
      }
      const wakeCommand = platform === 'win32' && bridgeEnvironment
        ? '%CODEXHOST_AGY_QUESTION_NODE% %CODEXHOST_AGY_WAKE_CLIENT%'
        : `${quote(nodePath)} ${quote(wakeClient)}`;
      hooks['dsh-unified-wake'] = {
        PreToolUse: [
          {
            matcher: DSH_AGY_WAKE_MATCHER,
            hooks: [
              {
                type: 'command',
                command: wakeCommand,
                timeout: 15,
              },
            ],
          },
        ],
      };
    }

    return { hooks, stop, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
