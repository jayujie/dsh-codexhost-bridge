// Normalize `file:///` Markdown links to local paths that DSH's Markdown renderer
// recognizes as native file links, and intercept clicks on already-saved `file:///` anchors.

function fileUriStripLocalPrefix(raw) {
  if (typeof raw !== 'string') return null
  const match = /^file:\/\/(?:localhost)?(\/.*)$/i.exec(raw)
  if (!match) return null
  let rest = match[1].replace(/\\/g, '/')
  // Decode an encoded Windows drive colon (e.g. `/D%3A/...` -> `/D:/...`).
  rest = rest.replace(/^\/([a-z])%3a\//i, '/$1:/')
  // Strip the leading `/` before a Windows drive letter (`/D:/...` -> `D:/...`).
  if (/^\/[a-z]:(?:\/|$)/i.test(rest)) rest = rest.slice(1)
  if (!rest || rest === '/') return null
  return rest
}

function fileUriRewriteDestination(dest) {
  const hashIndex = dest.indexOf('#')
  const rawPath = hashIndex === -1 ? dest : dest.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? '' : dest.slice(hashIndex)
  const localPath = fileUriStripLocalPrefix(rawPath)
  if (localPath === null) return null
  return localPath + fragment
}

/**
 * Rewrite Markdown inline links whose destination uses a local `file:///` or
 * `file://localhost/` URI into a local file path (`D:/...` or `/...`) while
 * skipping fenced code blocks, inline code spans, and image syntax `![...]`.
 */
export function normalizeFileUriMarkdownLinks(text) {
  if (typeof text !== 'string' || !/file:\/\//i.test(text)) return text
  const len = text.length
  let out = ''
  let i = 0
  let lineStart = true

  while (i < len) {
    // Skip fenced code blocks (``` or ~~~) starting at line start (up to 3 spaces).
    if (lineStart) {
      let ws = i
      while (ws < len && text[ws] === ' ' && ws - i < 3) ws++
      const ch = text[ws]
      if (ch === '`' || ch === '~') {
        let fenceEnd = ws
        while (fenceEnd < len && text[fenceEnd] === ch) fenceEnd++
        const fenceLen = fenceEnd - ws
        if (fenceLen >= 3 && (ch === '~' || text.slice(fenceEnd, text.indexOf('\n', fenceEnd) === -1 ? len : text.indexOf('\n', fenceEnd)).indexOf('`') === -1)) {
          let cursor = text.indexOf('\n', fenceEnd)
          if (cursor === -1) {
            out += text.slice(i)
            return out
          }
          cursor += 1
          while (cursor < len) {
            const nextNl = text.indexOf('\n', cursor)
            const endOfLine = nextNl === -1 ? len : nextNl
            const line = text.slice(cursor, endOfLine).replace(/\r$/, '')
            const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
            cursor = nextNl === -1 ? len : nextNl + 1
            if (closeMatch && closeMatch[1][0] === ch && closeMatch[1].length >= fenceLen) break
          }
          out += text.slice(i, cursor)
          i = cursor
          lineStart = true
          continue
        }
      }
    }

    const ch = text[i]
    if (ch === '`') {
      let tickEnd = i
      while (tickEnd < len && text[tickEnd] === '`') tickEnd++
      const ticks = text.slice(i, tickEnd)
      const close = text.indexOf(ticks, tickEnd)
      if (close !== -1) {
        const end = close + ticks.length
        out += text.slice(i, end)
        lineStart = text[end - 1] === '\n'
        i = end
        continue
      }
      out += ticks
      i = tickEnd
      lineStart = false
      continue
    }

    // Check inline link `](...)` (skipping image links where the matching `[` is preceded by `!`).
    if (ch === ']' && text[i + 1] === '(') {
      let isImage = false
      let depth = 0
      for (let back = i - 1; back >= 0 && i - back <= 2048; back--) {
        const bch = text[back]
        if (bch === '\n' && text[back - 1] === '\n') break
        if (bch === ']') depth++
        else if (bch === '[') {
          if (depth === 0) {
            isImage = back > 0 && text[back - 1] === '!'
            break
          }
          depth--
        }
      }

      if (!isImage) {
        let p = i + 2
        while (p < len && (text[p] === ' ' || text[p] === '\t')) p++
        const leadingSpace = text.slice(i + 2, p)
        if (text[p] === '<') {
          const closeAngle = text.indexOf('>', p + 1)
          if (closeAngle !== -1 && text.slice(p + 1, closeAngle).indexOf('\n') === -1) {
            const rawDest = text.slice(p + 1, closeAngle)
            const rewritten = fileUriRewriteDestination(rawDest)
            if (rewritten !== null) {
              out += `](${leadingSpace}<${rewritten}>`
              i = closeAngle + 1
              lineStart = false
              continue
            }
          }
        } else if (/^file:\/\//i.test(text.slice(p, p + 7))) {
          let end = p
          let parenDepth = 0
          while (end < len) {
            const dch = text[end]
            if (dch === ' ' || dch === '\t' || dch === '\r' || dch === '\n') break
            if (dch === '(') { parenDepth++; end++; continue }
            if (dch === ')') {
              if (parenDepth === 0) break
              parenDepth--; end++; continue
            }
            end++
          }
          const rawDest = text.slice(p, end)
          const rewritten = fileUriRewriteDestination(rawDest)
          if (rewritten !== null) {
            out += `](${leadingSpace}${rewritten}`
            i = end
            lineStart = false
            continue
          }
        }
      }
    }

    out += ch
    lineStart = ch === '\n'
    i++
  }
  return out
}

function fileUriSafeDecode(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

/**
 * Parse a `file:///` or `file://localhost/` anchor href into `{ path, line? }`
 * suitable for DSH's right-sidebar `file` resource opener.
 */
export function parseFileUriHref(href) {
  if (typeof href !== 'string') return null
  const trimmed = href.trim()
  if (!/^file:\/\//i.test(trimmed)) return null
  const hashIndex = trimmed.indexOf('#')
  const rawBase = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)
  const rawFragment = hashIndex === -1 ? '' : trimmed.slice(hashIndex + 1)
  const queryIndex = rawBase.indexOf('?')
  const baseNoQuery = queryIndex === -1 ? rawBase : rawBase.slice(0, queryIndex)
  let localPath = fileUriStripLocalPrefix(baseNoQuery)
  if (localPath === null) return null
  localPath = fileUriSafeDecode(localPath)

  let line
  const fragMatch = /^L?(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i.exec(rawFragment)
  if (fragMatch) {
    const parsed = Number.parseInt(fragMatch[1], 10)
    if (Number.isSafeInteger(parsed) && parsed > 0) line = parsed
  }
  if (line === undefined) {
    const suffixMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(localPath)
    if (suffixMatch && suffixMatch[1]) {
      const parsed = Number.parseInt(suffixMatch[2], 10)
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        localPath = suffixMatch[1]
        line = parsed
      }
    }
  }
  if (!localPath) return null
  return line === undefined ? { path: localPath } : { path: localPath, line }
}

function fileUriEncodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * Build a `dsh-resource://file/session/<sessionId>/<path>` address matching
 * `@deepseek-ai/dsh-util-workspace-path`'s `fileAddressFor`.
 */
export function buildSessionFileAddress(sessionId, filePath, cwd) {
  let target = filePath.replace(/\\/g, '/')
  if (typeof cwd === 'string' && cwd.trim()) {
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    const windowsDrive = /^[a-z]:(?:\/|$)/i.test(root)
    const targetPrefix = windowsDrive ? target.toLowerCase() : target
    const rootPrefix = windowsDrive ? root.toLowerCase() : root
    if (targetPrefix.startsWith(rootPrefix + '/')) {
      target = target.slice(root.length + 1)
    }
  }
  target = target.replace(/^(?:\.\/)+/, '')
  const encodedPath = target.split('/').map(fileUriEncodeSegment).join('/')
  return `dsh-resource://file/session/${fileUriEncodeSegment(sessionId)}/${encodedPath}`
}

function activeMainSessionId(scope) {
  const fromUiSession = scope.uiSession?.adapter?.current?.getSnapshot?.()?.props?.sessionId
  if (typeof fromUiSession === 'string' && fromUiSession) return fromUiSession
  const byId = scope.sessions?.list?.getSnapshot?.()?.byId
  if (byId && typeof byId === 'object') {
    for (const [id, summary] of Object.entries(byId)) {
      if ((summary?.retainedBy?.mainView ?? 0) > 0) return id
    }
  }
  return undefined
}

/**
 * Intercept left-clicks on `file:///` anchors (e.g. historical Antigravity messages
 * persisted before normalization) and open them in DSH's right sidebar.
 */
export function installFileUriLinkClient(scope) {
  if (typeof document === 'undefined' || !scope?.sidebarRight?.openResource) return () => {}
  const onClick = event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || !/^file:\/\//i.test(href.trim())) return
    const parsed = parseFileUriHref(href)
    if (!parsed) return
    const sessionId = activeMainSessionId(scope)
    if (!sessionId) return
    const cwd = scope.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
    const address = buildSessionFileAddress(sessionId, parsed.path, cwd)
    event.preventDefault()
    event.stopPropagation()
    if (parsed.line === undefined) scope.sidebarRight.openResource(address)
    else scope.sidebarRight.openResource(address, { params: { line: parsed.line } })
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
