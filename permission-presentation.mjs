/** Presentation only: native IDs and execution policies are never translated. */
const permissionViews = {
  codex: [
    { id: 'read-only', labelKey: 'permissionReadOnly', iconKind: 'read-only' },
    { id: 'workspace-write', labelKey: 'permissionWorkspaceWrite', iconKind: 'workspace-write' },
    { id: 'full-access', labelKey: 'permissionFullAccess', iconKind: 'full-access', dangerous: true },
  ],
  'claude-code': [
    { id: 'plan', labelKey: 'permissionPlan', iconKind: 'read-only' },
    { id: 'acceptEdits', labelKey: 'permissionEdit', iconKind: 'workspace-write' },
    { id: 'bypassPermissions', labelKey: 'permissionFullAccess', iconKind: 'full-access', dangerous: true },
  ],
  // Antigravity CLI offers exactly one native mode and runs without tool approval or a sandbox.
  // Show it as the dangerous full-access choice so it is never mistaken for a restricted mode.
  antigravity: [
    { id: 'dangerously-skip-permissions', labelKey: 'permissionFullAccess', iconKind: 'full-access', dangerous: true },
  ],
}

export function hostPermissionPresentation(agentId, mode) {
  const view = permissionViews[agentId]?.find(candidate => candidate.id === mode.id)
  if (view) return { ...mode, ...view, dangerous: mode.dangerous === true || view.dangerous === true }
  // Keep the truthful native selection visible without offering it as a new choice.
  // In particular default/auto must not silently become acceptEdits/bypassPermissions.
  const labelKey = agentId === 'claude-code' ? { default: 'permissionNativeDefault', auto: 'permissionNativeAuto' }[mode.id] : undefined
  return { ...mode, labelKey, iconKind: undefined }
}

export function hostPermissionOptions(agentId, modes = []) {
  const byId = new Map(modes.map(mode => [mode.id, mode]))
  return (permissionViews[agentId] ?? []).filter(view => byId.has(view.id)).map(view => hostPermissionPresentation(agentId, byId.get(view.id)))
}
