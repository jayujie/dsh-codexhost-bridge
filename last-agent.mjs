import { readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EXTERNAL_ENGINE_IDS, presetForEngine } from './external-engines.mjs'

export const LAST_AGENT_FILENAME = 'last-agent.json'
export const VALID_LAST_AGENTS = Object.freeze(['deepseek-harness', ...EXTERNAL_ENGINE_IDS])

export function isValidLastAgent(value) {
  return typeof value === 'string' && VALID_LAST_AGENTS.includes(value)
}

export function defaultPresetForLastAgent(agentId) {
  return EXTERNAL_ENGINE_IDS.includes(agentId) ? presetForEngine(agentId) : undefined
}

export function readLastAgentSync(filePath) {
  if (typeof filePath !== 'string' || !filePath) return undefined
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return isValidLastAgent(parsed?.agentId) ? parsed.agentId : undefined
  } catch {
    return undefined
  }
}

export async function writeLastAgent(filePath, agentId) {
  if (typeof filePath !== 'string' || !filePath || !isValidLastAgent(agentId)) return
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const payload = JSON.stringify({ version: 1, agentId, updatedAt: Date.now() }, null, 2) + '\n'
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmpPath, payload, 'utf8')
    await rename(tmpPath, filePath)
  } catch {
    await unlink(tmpPath).catch(() => {})
    await writeFile(filePath, payload, 'utf8')
  }
}
