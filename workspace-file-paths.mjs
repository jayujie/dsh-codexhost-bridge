/** Codex Markdown uses /C:/... destinations; Windows filesystems use C:/... . */
export function nativeFilePath(workspaceRoot, value) {
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(workspaceRoot ?? '') && /^\/[a-z]:[\\/]/i.test(value) ? value.slice(1) : value
}

/** Adapt the public file service while preserving its existing authorization and filesystem checks. */
export function installWorkspaceFilePaths(ctx) {
  return ctx.inject(['workspaceFiles'], scope => scope.effect(() => {
    const service = scope.workspaceFiles[Symbol.for('cordis.original')] ?? scope.workspaceFiles
    const descriptors = new Map()
    for (const name of ['read', 'readBytes', 'stat', 'list', 'changes']) {
      const original = service[name]
      const descriptor = Object.getOwnPropertyDescriptor(service, name)
      const adapted = function (workspaceFileScope, path, ...rest) {
        return original.call(this, workspaceFileScope, nativeFilePath(workspaceFileScope.workspaceRoot, path), ...rest)
      }
      descriptors.set(name, { descriptor, adapted })
      Object.defineProperty(service, name, { configurable: true, writable: true, value: adapted })
    }
    return () => {
      for (const [name, { descriptor, adapted }] of descriptors) {
        if (service[name] !== adapted) continue
        if (descriptor) Object.defineProperty(service, name, descriptor)
        else delete service[name]
      }
    }
  }, 'dsh-host: Windows file destinations'))
}
