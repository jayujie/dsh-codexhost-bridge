/** Permission profiles supported by the installed native Codex app-server schema. */
export const CODEX_PERMISSION_MODES = [
  { id: 'read-only', label: 'Read only' },
  { id: 'workspace-write', label: 'Workspace write' },
  { id: 'full-access', label: 'Full access', dangerous: true },
]

export function codexPermissionMode(id = 'workspace-write') {
  // 0.2.1 stored approval policy as its sole permission id.
  return id === 'on-request' ? 'workspace-write' : id
}

export function codexPermissionParameters(id, cwd) {
  const mode = codexPermissionMode(id)
  if (mode === 'full-access') return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  if (mode === 'read-only') return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
  if (mode === 'workspace-write') return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }
  throw new TypeError('Unsupported native Codex permission mode')
}
