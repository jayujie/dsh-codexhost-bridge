/** One SDK affordance over the existing scoped DSH pwsh/jobs tools; no process executor. */
export const NATIVE_BACKGROUND_SCHEMA = Object.freeze({
  name: 'dsh_background',
  description: 'Run background PowerShell commands as owned DSH jobs. Completion, failure and cancellation notify this DSH Agent through its normal inbox; do not also start a native background Bash/Agent. Use start to return a job id immediately, output/list to collect, stop to cancel. Native Bash remains available for foreground work. For teammates use dsh_collaboration subagent, not a shell-launched agent.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['start', 'list', 'output', 'stop'] },
      command: { type: 'string', description: 'PowerShell command for start; it is executed by the standard DSH pwsh tool, not native Bash.' },
      description: { type: 'string', description: 'Short description for start.' },
      workdir: { type: 'string', description: 'Optional working directory for start; defaults to this Agent workspace.' },
      job_id: { type: 'string', description: 'Owned DSH job id for output/stop.' },
      wait: { type: 'boolean', description: 'For output, wait for completion up to timeout_ms.' },
      timeout_ms: { type: 'number', description: 'Bounded wait for output, not an execution deadline.' },
      reason: { type: 'string', description: 'Cancellation reason for stop.' },
    },
  },
})

const nativeBackgroundFields = {
  pwsh: ['command', 'description', 'workdir', 'run_in_background'],
  job_list: [], job_output: ['job_id', 'wait', 'timeout_ms'], job_kill: ['job_id', 'reason'],
}
const nativeBackgroundString = (value, name, max = 32000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid background ${name}`)
}
const nativeBackgroundRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Revalidate on the authenticated server too: SDK schema is not an authorization boundary. */
export function validateNativeBackgroundCall(name, args) {
  const fields = Object.hasOwn(nativeBackgroundFields, name) ? nativeBackgroundFields[name] : undefined
  if (!fields || !nativeBackgroundRecord(args) || Object.keys(args).some(k => !fields.includes(k))) throw new TypeError('Invalid DSH background operation')
  if (name === 'pwsh') {
    nativeBackgroundString(args.command, 'command')
    if (args.run_in_background !== true) throw new TypeError('Only background pwsh is admitted through this channel')
    if (args.description !== undefined) nativeBackgroundString(args.description, 'description', 1024)
    if (args.workdir !== undefined) nativeBackgroundString(args.workdir, 'workdir', 4096)
  } else if (name !== 'job_list') {
    nativeBackgroundString(args.job_id, 'job id', 256)
    if (args.wait !== undefined && typeof args.wait !== 'boolean') throw new TypeError('Invalid background wait')
    if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) throw new TypeError('Invalid background timeout')
    if (args.reason !== undefined) nativeBackgroundString(args.reason, 'reason', 1024)
  }
  return { name, arguments: { ...args } }
}

export function nativeBackgroundOperation(input) {
  if (!nativeBackgroundRecord(input)) throw new TypeError('Invalid DSH background input')
  const names = { start: 'pwsh', list: 'job_list', output: 'job_output', stop: 'job_kill' }, name = names[input.action]
  if (!Object.hasOwn(names, input.action)) throw new TypeError('Unknown DSH background action')
  const allowed = nativeBackgroundFields[name].filter(k => k !== 'run_in_background')
  if (Object.keys(input).some(k => k !== 'action' && !allowed.includes(k))) throw new TypeError('Unexpected background input field')
  const args = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'action'))
  if (name === 'pwsh') args.run_in_background = true
  return validateNativeBackgroundCall(name, args)
}
