import dshCcFs from 'node:fs';
import * as dshCcFsPromises from 'node:fs/promises';
import dshCcOs from 'node:os';
import dshCcPath from 'node:path';
import { randomUUID as dshCcRandomUUID } from 'node:crypto';

export const DSH_CLAUDE_CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DSH_CLAUDE_CATALOG_CACHE_VERSION = 1;

export function dshClaudeCatalogCachePath(environment = process.env) {
  const dataDir = environment?.CODEXHOST_DATA_DIR
    ? dshCcPath.resolve(environment.CODEXHOST_DATA_DIR)
    : dshCcPath.join(dshCcOs.homedir(), '.codexhost');
  return dshCcPath.join(dataDir, 'claude-catalog-cache.json');
}

export function dshReadClaudeCatalogCache(environment, executable, inspectionSchema, { now = Date.now(), ttlMs = DSH_CLAUDE_CATALOG_CACHE_TTL_MS } = {}) {
  if (!executable || typeof executable !== 'string') return null;
  try {
    const stat = dshCcFs.statSync(executable);
    if (!stat.isFile()) return null;
    const raw = JSON.parse(dshCcFs.readFileSync(dshClaudeCatalogCachePath(environment), 'utf8'));
    if (!raw || raw.version !== DSH_CLAUDE_CATALOG_CACHE_VERSION || raw.executable !== executable) return null;
    if (raw.size !== stat.size || Math.floor(Number(raw.mtimeMs)) !== Math.floor(stat.mtimeMs)) return null;
    if (typeof raw.cachedAt !== 'number' || !Number.isFinite(raw.cachedAt)) return null;
    const age = now - raw.cachedAt;
    if (age < 0 || age > ttlMs) return null;
    const parsed = inspectionSchema ? inspectionSchema.safeParse(raw.result) : { success: true, data: raw.result };
    if (!parsed.success || parsed.data?.status !== 'ready') return null;
    return { result: parsed.data, cachedAt: raw.cachedAt };
  } catch {
    return null;
  }
}

export async function dshWriteClaudeCatalogCache(environment, executable, result, { now = Date.now() } = {}) {
  if (!executable || typeof executable !== 'string' || result?.status !== 'ready') return false;
  try {
    const stat = await dshCcFsPromises.stat(executable);
    if (!stat.isFile()) return false;
    const file = dshClaudeCatalogCachePath(environment);
    const dir = dshCcPath.dirname(file);
    await dshCcFsPromises.mkdir(dir, { recursive: true, mode: 448 });
    const tmp = dshCcPath.join(dir, `.${dshCcPath.basename(file)}.${dshCcRandomUUID()}.tmp`);
    try {
      await dshCcFsPromises.writeFile(tmp, `${JSON.stringify({
        version: DSH_CLAUDE_CATALOG_CACHE_VERSION,
        executable,
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        cachedAt: now,
        result,
      })}\n`, { mode: 384 });
      await dshCcFsPromises.rename(tmp, file);
      return true;
    } finally {
      await dshCcFsPromises.rm(tmp, { force: true }).catch(() => void 0);
    }
  } catch {
    return false;
  }
}
