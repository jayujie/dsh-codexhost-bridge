// Tests need DSH's zod; this package has no node_modules of its own. Order:
// explicit env override, a normal bare resolution, then the installed desktop profile.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const profileAnchor = path.join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json')

export function zodRequire(fallbackUrl = import.meta.url) {
  if (process.env.DSH_TEST_RESOLVER) return createRequire(process.env.DSH_TEST_RESOLVER)
  const local = createRequire(fallbackUrl)
  try { local.resolve('zod'); return local } catch {}
  if (existsSync(profileAnchor)) return createRequire(profileAnchor)
  return local
}

export function zodUrl() {
  if (process.env.DSH_TEST_ZOD_URL) return process.env.DSH_TEST_ZOD_URL
  return pathToFileURL(zodRequire().resolve('zod')).href
}
