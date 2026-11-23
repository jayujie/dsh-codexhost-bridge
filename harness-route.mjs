/** CodexHost v0.17.4 canonical create-route order; see shared-contracts/harness-route.ts. */
export function encodeNativeHarnessRoute(harnessId, selection) {
  // The Host decodes, schema-normalizes and re-encodes this value. Order matters.
  const route = {
    harnessId,
    model: { id: selection.modelId },
    ...(selection.thinkingOptionId ? { thinkingOptionId: selection.thinkingOptionId } : {}),
    permissionModeId: selection.permissionModeId,
  }
  return `codexhost/plugin-v1@${Buffer.from(JSON.stringify(route)).toString('hex')}`
}
