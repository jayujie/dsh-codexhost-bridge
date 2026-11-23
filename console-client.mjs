import { createElement as h, useEffect, useRef, useState } from 'react'
import { consoleRemoteContribution } from './console-contract.mjs'
import { AGENT_ICONS } from './icons.mjs'
import { Button as DshConsoleButton } from '@deepseek-ai/dsh-client-ui-primitives'

export const CONSOLE_PANEL_ID = 'codexhost-console'
export function installConsoleClient(ctx, t) {
  ctx.effect(async () => await ctx.remote.$mount(consoleRemoteContribution))
  ctx.inject(['remote.codexHostConsole', 'uiWorkspace'], scope => {
    scope.remoteAccess.whenAccess('codexHostConsole/bootstrap', function* () {
      yield scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: CONSOLE_PANEL_ID,
        inject: () => ({ consoleRemote: scope.remote.codexHostConsole, openSession: id => scope.uiWorkspace.openSession(id), t }),
      }, ConsolePanel))
      yield scope.slots.inject('sidebar.footer.action', () => scope.slots.register({ name: 'sidebar.footer.action', id: CONSOLE_PANEL_ID, order: 100,
        inject: () => ({ openConsole: () => scope.layout.selectPanel(CONSOLE_PANEL_ID), t }),
      }, ConsoleFooterAction))
    })
  })
}
function ConsoleFooterAction({ wide, openConsole, t }) {
  return h('button', { type: 'button', className: 'dh-console-trigger', 'data-wide': String(wide),
    title: t('console'), 'aria-label': t('console'), onClick: openConsole,
  }, h(ConsoleIcon, { size: 20 }))
}
function ConsoleIcon({ size = 20 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
    h('path', { d: 'm7 9 3 3-3 3m6 0h4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}
function DhTabIcon({ id }) {
  const props = { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': true, className: 'dh-tab-ico' }
  if (id === 'overview') return h('svg', props, h('rect', { x: 2.5, y: 2.5, width: 6, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }), h('rect', { x: 11.5, y: 2.5, width: 6, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }), h('rect', { x: 2.5, y: 11.5, width: 6, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }), h('rect', { x: 11.5, y: 11.5, width: 6, height: 6, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.5 }))
  if (id === 'connections') return h('svg', props, h('circle', { cx: 5, cy: 10, r: 2.5, stroke: 'currentColor', strokeWidth: 1.5 }), h('circle', { cx: 15, cy: 5.5, r: 2.5, stroke: 'currentColor', strokeWidth: 1.5 }), h('circle', { cx: 15, cy: 14.5, r: 2.5, stroke: 'currentColor', strokeWidth: 1.5 }), h('path', { d: 'M7.3 9l5.4-2.5M7.3 11l5.4 2.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
  if (id === 'accounts') return h('svg', props, h('circle', { cx: 10, cy: 6.8, r: 3.1, stroke: 'currentColor', strokeWidth: 1.5 }), h('path', { d: 'M4 16.5c.8-2.9 3.1-4.5 6-4.5s5.2 1.6 6 4.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
  if (id === 'sessions') return h('svg', props, h('path', { d: 'M10 3.5v8.5m0 0-3-3m3 3 3-3', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }), h('path', { d: 'M3.5 13.5v1.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-1.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
  return h('svg', props, h('path', { d: 'M4 16V10.5M10 16V5M16 16V8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }))
}
const dhTabs = [['overview', '总览'], ['connections', 'Agent 连接'], ['accounts', '账号'], ['sessions', '会话导入'], ['usage', '用量统计']]
const dhRanges = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['90d', '近 90 天'], ['all', '全部']]
const dhName = id => ({ codex: 'Codex', 'claude-code': 'Claude Code', antigravity: 'Antigravity', 'deepseek-harness': 'DSH' })[id] ?? id
const dhEngineMeta = {
  codex: { desc: '使用 Codex 原生模型、沙箱工具与会话历史。', tags: ['原生工具', '审批控制', '历史导入'] },
  'claude-code': { desc: '使用 Claude Code 原生模型、技能与子代理协作。', tags: ['1h 缓存', '原生命令', '历史导入'] },
  antigravity: { desc: '使用 Antigravity CLI 原生模型、工作区工具与会话历史。', tags: ['516K 上下文', '自动压缩', '历史导入'] },
}
const dhNum = n => typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '—'
const dhCompact = n => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  return dhNum(n)
}
const dhMoney = n => typeof n === 'number' && Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '—'
const dhReply = r => { if (r?.ok === false) throw new Error(r.error?.message ?? String(r.error)); return r?.ok === true ? r.value : r }
function dhButton(label, onClick, props = {}) { return h(DshConsoleButton, { size: 'sm', variant: props.className === 'dh-primary' ? 'primary' : 'outline', type: 'button', onClick, ...props }, label) }
function dhAgent(id, badge = false) {
  const icon = h('img', { src: AGENT_ICONS[id], alt: '', width: badge ? 20 : 20, height: badge ? 20 : 20 })
  return h('span', { className: 'dh-agent' }, badge ? h('span', { className: 'dh-agent-badge' }, icon) : icon, h('span', null, dhName(id)))
}
function dhPairs(rows) {
  return h('dl', { className: 'dh-pairs' }, rows.map(([name, value, mono]) =>
    h('div', { key: name }, h('dt', null, name), h('dd', { className: mono ? 'dh-mono' : undefined }, value ?? '—'))))
}
function dhCard(title, body, props = {}) {
  const { headerRight, className = '', ...rest } = props
  return h('section', { className: `dh-card ${className}`.trim(), ...rest },
    headerRight ? h('div', { className: 'dh-card-head' }, h('h3', null, title), headerRight) : h('h3', null, title),
    body)
}
function useConsoleData(remote, input) {
  const key = JSON.stringify(input), [revision, setRevision] = useState(0), [state, setState] = useState({ loading: true })
  useEffect(() => {
    let current = true
    setState(s => ({ ...(s.key === key ? s : {}), key, loading: true, error: undefined }))
    remote.request(input).then(dhReply).then(data => { if (current) setState({ key, loading: false, data, updatedAt: Date.now() }) }).catch(error => { if (current) setState(s => ({ ...s, key, loading: false, error: error.message })) })
    return () => { current = false }
  }, [remote, key, revision])
  return [state.key === key ? state : { loading: true }, () => setRevision(r => r + 1)]
}
function dhFeedback(state) {
  return state.error
    ? h('div', { className: 'dh-feedback dh-error', role: 'alert' }, state.data ? '刷新失败，以下保留上次读取的结果。\n' : '', state.error)
    : state.loading
      ? h('div', { className: 'dh-feedback dh-loading', role: 'status' }, h('span', { className: 'dh-spinner', 'aria-hidden': true }), h('span', null, state.data ? '正在刷新，以下为上次读取的结果…' : '正在读取…'))
      : null
}
function dhUpdated(state) { return state.updatedAt ? h('small', { className: 'dh-updated' }, `上次读取 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN')}`) : null }
function dhRefresh(state, reload, label = '刷新') { return h('div', { className: 'dh-actions dh-toolbar-right' }, dhUpdated(state), dhButton(label, reload, { disabled: state.loading })) }

function ConsolePanel({ consoleRemote, openSession }) {
  const [tab, setTab] = useState('overview')
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState({ checking: false, data: null, error: '', applying: false, applied: null })
  const checkUpdate = (refresh = false) => {
    setUpdate(u => ({ ...u, checking: true, error: '' }))
    consoleRemote.request({ action: 'updateCheck', ...(refresh ? { refresh: true } : {}) }).then(dhReply)
      .then(data => setUpdate(u => ({ ...u, checking: false, data, error: '' })))
      .catch(error => setUpdate(u => ({ ...u, checking: false, error: refresh ? error.message : '' })))
  }
  const applyUpdate = () => {
    const target = update.data?.latestVersion
    setUpdate(u => ({ ...u, applying: true, error: '', applied: null }))
    consoleRemote.request({ action: 'updateApply', ...(target ? { version: target } : {}) }).then(dhReply)
      .then(applied => setUpdate(u => ({ ...u, applying: false, applied, error: '' })))
      .catch(error => setUpdate(u => ({ ...u, applying: false, error: error.message })))
  }
  useEffect(() => {
    let active = true
    consoleRemote.bootstrap?.().then(dhReply).then(info => { if (active && info?.version) setVersion(String(info.version)) }).catch(() => {})
    consoleRemote.request({ action: 'updateCheck' }).then(dhReply)
      .then(data => { if (active) setUpdate(u => ({ ...u, data })) }).catch(() => {})
    return () => { active = false }
  }, [consoleRemote])
  const info = update.data
  const displayVersion = version || info?.currentVersion || '0.6.1'
  return h('section', { className: 'dh-console', 'aria-label': 'DSH Host 控制台' },
    h('header', { className: 'dh-header' },
      h('div', { className: 'dh-header-lead' },
        h('div', { className: 'dh-brand-mark', 'aria-hidden': true }, h(ConsoleIcon, { size: 22 })),
        h('div', null,
          h('div', { className: 'dh-brand' }, h('h1', null, 'DSH Host')),
          h('p', null, '在 DSH 中统一管理 Codex、Claude Code 与 Antigravity'))),
      h('div', { className: 'dh-header-meta' },
        h('span', { className: `dh-chip ${info?.updateAvailable ? 'dh-chip-update' : ''}`.trim() },
          h('span', { className: `dh-dot ${info?.updateAvailable ? 'dh-dot-warn' : 'dh-dot-ok'}`, 'aria-hidden': true }),
          info?.updateAvailable ? `可更新 · v${info.latestVersion}` : `本机 · v${displayVersion}`),
        dhButton(update.checking ? '检查中…' : '检查更新', () => checkUpdate(true), { disabled: update.checking || update.applying, className: 'dh-update-check-btn' }))),
    h('nav', { className: 'dh-tabs', 'aria-label': '控制台导航' },
      dhTabs.map(([id, label]) => dhButton(h('span', { className: 'dh-tab-label' }, h(DhTabIcon, { id }), label), () => setTab(id), { key: id, variant: 'ghost', 'aria-current': tab === id ? 'page' : undefined }))),
    (info?.updateAvailable || update.applied || update.error) ? h('div', { className: 'dh-update-wrap' },
      update.error ? h('div', { className: 'dh-feedback dh-error', role: 'alert' }, update.error) : null,
      update.applied ? h('div', { className: 'dh-import-result', role: 'status' }, h('span', null, update.applied.message)) : null,
      info?.updateAvailable && !update.applied ? h('div', { className: 'dh-update-banner', role: 'status' },
        h('div', { className: 'dh-update-copy' },
          h('strong', null, `发现 DSH Host 新版本 v${info.latestVersion}`),
          h('span', null, `当前版本 v${info.currentVersion}${info.installMode === 'link' ? '（本地开发链接模式，请执行 git pull 更新）' : ''}`)),
        h('div', { className: 'dh-update-actions' },
          info.releaseUrl ? h('a', { className: 'dh-link-btn', href: info.releaseUrl, target: '_blank', rel: 'noreferrer' }, '查看更新说明') : null,
          info.canAutoUpdate ? dhButton(update.applying ? '正在更新…' : '一键更新', applyUpdate, { className: 'dh-primary', disabled: update.applying }) : null)) : null) : null,
    h('div', { className: 'dh-body', key: tab },
      tab === 'overview' ? h(DhOverview, { remote: consoleRemote, navigate: setTab })
        : tab === 'connections' ? h(DhConnections, { remote: consoleRemote })
          : tab === 'accounts' ? h(DhAccounts, { remote: consoleRemote })
            : tab === 'sessions' ? h(DhImports, { remote: consoleRemote, openSession })
              : h(DhUsage, { remote: consoleRemote })))
}

function DhOverview({ remote, navigate }) {
  const [s, reload] = useConsoleData(remote, { action: 'overview' })
  return h('div', null,
    h('div', { className: 'dh-section-title' }, h('div', null, h('h2', null, '总览'), h('p', { className: 'dh-sub' }, '本地外部引擎桥接状态与快捷入口')), dhRefresh(s, reload)),
    dhFeedback(s),
    s.data ? h('div', { className: 'dh-metrics' }, [
      ['后台连接', h('span', { className: 'dh-status-inline' }, h('span', { className: 'dh-dot dh-dot-ok', 'aria-hidden': true }), '已连接'), '按需启动，共用原生会话连接'],
      ['工作区', dhNum(s.data.workspaces), '沿用 DSH 原生项目目录'],
      ['已加载外部会话', dhNum(s.data.externalSessions), '当前进程中活跃的 Codex / Claude / AGY 会话'],
    ].map(([title, value, note]) => dhCard(title, h('div', null, h('strong', { className: 'dh-value' }, value), h('p', { className: 'dh-metric-note' }, note)), { key: title }))) : null,
    h('div', { className: 'dh-grid' }, ['codex', 'claude-code', 'antigravity'].map(id => {
      const meta = dhEngineMeta[id]
      return dhCard(dhAgent(id, true),
        h('div', { className: 'dh-card-body' },
          h('p', null, meta.desc),
          h('div', { className: 'dh-tags' }, meta.tags.map(tag => h('span', { key: tag, className: 'dh-tag' }, tag))),
          h('div', { className: 'dh-card-foot' },
            dhButton('检查连接', () => navigate('connections')),
            dhButton('导入会话', () => navigate('sessions')))),
        { key: id, className: 'dh-card-engine' })
    })),
    h('section', { className: 'dh-guide', 'aria-label': '开始使用与功能边界' },
      h('div', { className: 'dh-guide-col' },
        h('h3', null, '从原生会话开始'),
        h('ol', { className: 'dh-steps' },
          h('li', null, h('span', { className: 'dh-step-num' }, '1'), h('span', null, '选择工作区并新建会话')),
          h('li', null, h('span', { className: 'dh-step-num' }, '2'), h('span', null, '在输入栏选择 Agent、模型与权限模式')),
          h('li', null, h('span', { className: 'dh-step-num' }, '3'), h('span', null, '直接发送；已有 CLI 历史可从「会话导入」接续')))),
      h('div', { className: 'dh-guide-col' },
        h('h3', null, '运行说明与边界'),
        h('p', null, '已支持流式回复、工具执行与 Diff 记录、审批 / 提问交互、跨 Agent 委派、用量计费及原生会话历史导入。'),
        h('p', null, '会话与文件预览沿用 DSH 原生界面；后台已连接不代表每个引擎的凭据与模型均可调用，建议在「Agent 连接」单独确认。'))))
}

function DhConnections({ remote }) {
  const [s, reload] = useConsoleData(remote, { action: 'connections', refresh: true }), [entry, setEntry] = useState(null), [saving, setSaving] = useState(false), [message, setMessage] = useState('')
  const save = async () => { setSaving(true); setMessage(''); try { const r = dhReply(await remote.request({ action: 'claudePath', path: entry?.trim() || null })); setMessage(r.restartRequired ? '路径已保存，下次重启后台 Host 后生效。' : '路径已保存。'); reload() } catch (e) { setMessage(e.message) } finally { setSaving(false) } }
  return h('div', null,
    h('div', { className: 'dh-section-title' }, h('div', null, h('h2', null, 'Agent 连接'), h('p', { className: 'dh-sub' }, '检测本机 CLI 可用性、模型目录与安装路径')), dhRefresh(s, reload, '重新检查')),
    dhFeedback(s),
    s.data ? h('div', { className: 'dh-grid' }, ['codex', 'claude-code', 'antigravity'].map(id => {
      const r = id === 'codex' ? s.data.codex : id === 'claude-code' ? s.data.claude : (s.data.antigravity ?? { status: 'error', models: [], path: '' })
      const ok = r.status === 'ready'
      return dhCard(dhAgent(id, true),
        h('div', { className: 'dh-card-body' },
          r.error ? h('p', { role: 'alert', className: 'dh-inline-alert dh-error' }, r.error) : null,
          dhPairs([['模型数量', `${r.models.length} 个`], ['安装路径', r.path || '自动发现', true]]),
          id === 'claude-code' ? h('div', { className: 'dh-field dh-subpanel' },
            h('label', { htmlFor: 'dh-claude-path' }, 'Claude Code 安装目录'),
            h('div', { className: 'dh-field-row' },
              h('input', { id: 'dh-claude-path', value: entry ?? r.path, placeholder: '留空使用自动发现', onChange: e => setEntry(e.target.value) }),
              dhButton('保存路径', save, { disabled: saving || entry === null })),
            message ? h('p', { role: 'status', className: 'dh-field-msg' }, message) : null) : null,
          h('details', { className: 'dh-details' },
            h('summary', null, h('span', null, '可用模型'), h('span', { className: 'dh-count-pill' }, r.models.length)),
            r.models.length
              ? h('ul', { className: 'dh-models' }, r.models.map(m => h('li', { key: m.id, title: m.id }, m.label)))
              : h('p', { className: 'dh-muted-box' }, '暂未发现可用模型'))),
        { key: id, headerRight: h('span', { className: `dh-state ${ok ? 'dh-ready' : 'dh-warn'}` }, h('span', { className: `dh-dot ${ok ? 'dh-dot-ok' : 'dh-dot-warn'}`, 'aria-hidden': true }), ok ? '可用' : '需要检查') })
    })) : null,
    h('p', { className: 'dh-note' }, '登录、密钥和服务地址沿用各 Agent 的本机配置。保存安装路径不会中断正在进行的会话。'))
}

function DhAccounts({ remote }) {
  const [s, reload] = useConsoleData(remote, { action: 'accounts', refresh: true })
  const codex = s.data?.codex, claude = s.data?.claude, agy = s.data?.antigravity, account = codex?.value?.accounts?.find(a => a.accountId === codex.value.currentAccountId), ca = claude?.value?.account, aa = agy?.value?.account
  const quota = s.data?.quota?.value
  return h('div', null,
    h('div', { className: 'dh-section-title' }, h('div', null, h('h2', null, '账号与额度'), h('p', { className: 'dh-sub' }, '原生上游返回的登录账号与实时配额')), dhRefresh(s, reload, '刷新额度')),
    dhFeedback(s),
    s.data ? h('div', { className: 'dh-grid' },
      dhCard(dhAgent('codex', true),
        h('div', { className: 'dh-card-body' },
          codex.error ? h('p', { className: 'dh-inline-alert dh-error' }, codex.error) : null,
          dhPairs([['账号', account?.email ?? account?.label ?? '未提供账号信息'], ['套餐', account?.planType ?? '未提供'], ['状态', codex.value?.phase === 'ready' ? '已连接' : '未就绪'], ['额度来源', quota?.freshness === 'live' ? '原生实时观测' : quota ? '原生缓存观测' : '未提供']]),
          s.data.quota?.error ? h('p', { className: 'dh-inline-alert dh-error', role: 'alert' }, `额度读取失败：${s.data.quota.error}`) : quota?.accountCredits ? h(DhCredits, { credits: quota.accountCredits }) : h('p', { className: 'dh-muted-box' }, '上游未提供可显示的剩余额度。')),
        { headerRight: h('span', { className: `dh-state ${codex.value?.phase === 'ready' ? 'dh-ready' : 'dh-warn'}` }, codex.value?.phase === 'ready' ? '已连接' : '未就绪') }),
      dhCard(dhAgent('claude-code', true),
        h('div', { className: 'dh-card-body' },
          claude.error ? h('p', { className: 'dh-inline-alert dh-error' }, claude.error) : null,
          ca ? h('div', null, dhPairs([['账号', ca.email ?? ca.label ?? '原生账号'], ['套餐', ca.plan], ['余额', ca.balance ? `${ca.balance.amount} ${ca.balance.currency}` : undefined]]), ca.credits ? h(DhCredits, { credits: ca.credits }) : null) : h('p', { className: 'dh-muted-box' }, '当前 Claude Code 上游未提供账号余额或额度。'))),
      agy ? dhCard(dhAgent('antigravity', true),
        h('div', { className: 'dh-card-body' },
          agy.error ? h('p', { className: 'dh-inline-alert dh-error' }, agy.error) : null,
          aa ? h('div', null, dhPairs([['账号', aa.email ?? aa.label ?? 'Google 账号'], ['套餐', aa.plan]]), aa.credits ? h(DhCredits, { credits: aa.credits }) : null) : h('p', { className: 'dh-muted-box' }, '由 agy 本机维护 Google 登录态。'))) : null) : null,
    h('p', { className: 'dh-note' }, '这里只显示原生上游返回的账号与额度；API 价值是按单价计算的消耗估算，不等于账号账单或余额。'))
}

function DhCredits({ credits }) {
  const pct = typeof credits.usedPercent === 'number' && Number.isFinite(credits.usedPercent) ? Math.min(100, Math.max(0, credits.usedPercent)) : null
  const tone = pct === null ? '' : pct >= 90 ? 'dh-bar-danger' : pct >= 70 ? 'dh-bar-warn' : 'dh-bar-ok'
  return h('div', { className: 'dh-credits-box' },
    pct !== null ? h('div', { className: 'dh-meter' },
      h('div', { className: 'dh-meter-head' }, h('span', null, credits.label || '已用配额'), h('strong', null, `${pct.toFixed(1)}%`)),
      h('div', { className: 'dh-meter-track', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('div', { className: `dh-meter-fill ${tone}`, style: { width: `${pct}%` } }))) : null,
    dhPairs([
      ['额度', credits.label],
      ['已用比例', pct !== null ? `${pct.toFixed(1)}%` : undefined],
      ['已用 / 限额', credits.limit === undefined ? undefined : `${credits.used ?? '—'} / ${credits.limit} ${credits.unit ?? ''}`],
      ['重置时间', credits.resetsAt ? new Date(credits.resetsAt).toLocaleString('zh-CN') : undefined],
    ]))
}

function DhImports({ remote, openSession }) {
  const [agent, setAgent] = useState('codex'), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState({}), [selected, setSelected] = useState(null), [idle, setIdle] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [imported, setImported] = useState(null)
  const operation = useRef(false)
  const [s, reload] = useConsoleData(remote, { action: 'sessions', harnessId: agent, query: search, ...page })
  const choose = id => { setAgent(id); setPage({}); setSelected(null); setIdle(false); setError('') }
  const reopen = async id => {
    try { await openSession(id); setSelected(null) }
    catch (e) { setError(`会话已导入，但打开失败：${e.message}。请点击「打开已导入会话」重试，无需再次导入。`) }
  }
  const startImport = async () => {
    if (operation.current || !selected || !idle) return
    operation.current = true; setBusy(true); setError('')
    try {
      const r = dhReply(await remote.request({ action: 'import', harnessId: agent, kind: selected.kind, id: selected.id, acknowledgeIdle: idle }))
      setImported({ sessionId: r.sessionId, title: selected.title }); setSelected(null)
      await reopen(r.sessionId)
    } catch (e) { setError(e.message) } finally { operation.current = false; setBusy(false) }
  }
  const retryOpen = async () => {
    if (operation.current || !imported) return
    operation.current = true; setBusy(true); setError('')
    try { await reopen(imported.sessionId) } finally { operation.current = false; setBusy(false) }
  }
  return h('div', null,
    h('div', { className: 'dh-section-title' }, h('div', null, h('h2', null, '会话导入'), h('p', { className: 'dh-sub' }, '保留原工作目录、标题、消息和工具历史，导入后在 DSH 中直接续聊')), dhButton('刷新', reload, { disabled: s.loading || busy })),
    h('div', { className: 'dh-import-toolbar' },
      h('div', { className: 'dh-segment', 'aria-label': '导入来源' }, ['codex', 'claude-code', 'antigravity'].map(id => dhButton(dhAgent(id), () => choose(id), { key: id, variant: 'ghost', disabled: busy, 'aria-pressed': agent === id }))),
      h('form', { className: 'dh-search', onSubmit: e => { e.preventDefault(); if (busy) return; setSelected(null); setSearch(query.trim()); setPage({}); reload() } },
        h('input', { 'aria-label': '搜索会话', value: query, placeholder: '搜索原生会话标题或路径…', onChange: e => setQuery(e.target.value), disabled: busy }),
        h('button', { type: 'submit', className: 'dh-search-btn', disabled: s.loading || busy }, '搜索'))),
    dhFeedback(s), error ? h('div', { className: 'dh-feedback dh-error', role: 'alert' }, error) : null,
    imported ? h('div', { className: 'dh-import-result', role: 'status' }, h('span', null, `已导入：${imported.title}`), dhButton('打开已导入会话', retryOpen, { disabled: busy })) : null,
    selected ? h('section', { className: 'dh-import-confirm', 'aria-label': '确认导入会话' },
      h('div', { className: 'dh-confirm-head' }, h('span', { className: 'dh-tag dh-tag-accent' }, '即将导入'), h('strong', null, selected.title)),
      h('p', { className: 'dh-path dh-mono' }, selected.cwd),
      h('label', { className: 'dh-check' }, h('input', { type: 'checkbox', checked: idle, onChange: e => setIdle(e.target.checked), disabled: busy }), '我已停止原客户端中的此会话，避免两边同时写入'),
      h('div', { className: 'dh-actions' }, dhButton(busy ? '正在导入…' : '导入到 DSH 并打开', startImport, { className: 'dh-primary', disabled: !idle || busy }), dhButton('取消', () => setSelected(null), { disabled: busy }))) : null,
    s.data && !s.loading ? h('div', { className: 'dh-session-list' }, s.data.rows.length ? s.data.rows.map(row =>
      h('article', { className: `dh-session ${selected?.id === row.id && selected?.kind === row.kind ? 'dh-session-active' : ''}`.trim(), key: `${row.kind}:${row.id}` },
        h('div', { className: 'dh-session-copy' },
          h('div', { className: 'dh-session-top' },
            h('strong', { title: row.title }, row.title),
            h('span', { className: `dh-tag ${row.kind === 'native' ? 'dh-tag-accent' : ''}`.trim() }, row.kind === 'native' ? 'CLI 本机历史' : '原生 Agent 会话'),
            row.running ? h('span', { className: 'dh-tag dh-tag-warn' }, '正在运行') : null),
          h('div', { className: 'dh-path dh-mono' }, row.cwd),
          h('small', null, `更新于 ${new Date(row.updatedAt * 1000).toLocaleString('zh-CN')}`)),
        dhButton('导入', () => { setSelected(row); setIdle(false); setError('') }, { disabled: busy || row.running === true })))
      : h('div', { className: 'dh-empty' }, '本页没有可导入的会话。')) : null,
    s.data ? h('div', { className: 'dh-actions' }, Object.keys(page).length ? dhButton('返回最新', () => { setPage({}); setSelected(null) }, { disabled: busy || s.loading }) : null,
      s.data.nextCursor || Number.isInteger(s.data.nextOffset) ? dhButton('下一页', () => { setSelected(null); setPage({ cursor: s.data.nextCursor ?? 'end', offset: s.data.nextOffset ?? (page.offset ?? 0) + 20 }) }, { disabled: busy || s.loading }) : null) : null)
}

function DhUsage({ remote }) {
  const [range, setRange] = useState('7d'), [harness, setHarness] = useState(''), [s, reload] = useConsoleData(remote, { action: 'usage', range, ...(harness ? { harness } : {}) })
  const totals = s.data?.totals
  const uncachedIn = totals ? Math.max(0, totals.inputTokens - totals.cachedInputTokens - totals.cacheWriteInputTokens) : 0
  const cacheRead = totals?.cachedInputTokens ?? 0
  const cacheWrite = totals?.cacheWriteInputTokens ?? 0
  const outputTok = totals?.outputTokens ?? 0
  const totalTok = uncachedIn + cacheRead + cacheWrite + outputTok
  const hitRate = totals && totals.cacheHitInputTokens > 0 ? (totals.cacheHitCachedInputTokens / totals.cacheHitInputTokens * 100) : null
  const pctOf = n => totalTok > 0 ? `${(n / totalTok * 100).toFixed(2)}%` : '0%'
  return h('div', null,
    h('div', { className: 'dh-section-title' }, h('div', null, h('h2', null, '用量统计'), h('p', { className: 'dh-sub' }, '原生日志汇总的 Token 构成、缓存命中率与 API 价值估算')), dhRefresh(s, reload)),
    h('div', { className: 'dh-filter-bar' },
      h('div', { className: 'dh-segment dh-range-pills', 'aria-label': '统计时间范围' },
        dhRanges.map(([id, label]) => dhButton(label, () => setRange(id), { key: id, variant: 'ghost', 'aria-pressed': range === id }))),
      h('select', { 'aria-label': '统计 Agent', value: harness, onChange: e => setHarness(e.target.value) },
        h('option', { value: '' }, '全部 Agent'),
        ['codex', 'claude-code', 'antigravity', 'deepseek-harness'].map(id => h('option', { key: id, value: id }, dhName(id))))),
    dhFeedback(s),
    s.data?.reading?.complete === false ? h('p', { role: 'status', className: 'dh-feedback' }, '原生记录正在扫描，当前显示已读取的统计；稍后刷新可取得完整数据。') : null,
    totals ? h('div', null,
      h('div', { className: 'dh-metrics' },
        dhCard('API 价值', h('div', null, h('strong', { className: 'dh-value dh-value-accent' }, dhMoney(totals.costUsd)), h('p', { className: 'dh-metric-note' }, `${dhNum(totals.requests)} 次请求${totals.unpricedRequests ? ` · ${dhNum(totals.unpricedRequests)} 未计价` : ''}`))),
        dhCard('Token 总量', h('div', null, h('strong', { className: 'dh-value' }, dhCompact(totals.inputTokens + totals.outputTokens)), h('p', { className: 'dh-metric-note' }, `${dhNum(totals.inputTokens + totals.outputTokens)} tok`))),
        dhCard('缓存命中', h('div', null,
          h('strong', { className: 'dh-value' }, hitRate !== null ? `${hitRate.toFixed(1)}%` : '—'),
          hitRate !== null ? h('div', { className: 'dh-meter-track dh-meter-mini' }, h('div', { className: 'dh-meter-fill dh-bar-ok', style: { width: `${Math.min(100, hitRate)}%` } })) : h('p', { className: 'dh-metric-note' }, '暂无缓存读记录')))),
      dhCard('Token 构成', h('div', null,
        totalTok > 0 ? h('div', { className: 'dh-stack-bar', 'aria-hidden': true },
          h('span', { className: 'dh-seg-read', style: { width: pctOf(cacheRead) }, title: `缓存读取 ${dhNum(cacheRead)}` }),
          h('span', { className: 'dh-seg-write', style: { width: pctOf(cacheWrite) }, title: `缓存写入 ${dhNum(cacheWrite)}` }),
          h('span', { className: 'dh-seg-in', style: { width: pctOf(uncachedIn) }, title: `未缓存输入 ${dhNum(uncachedIn)}` }),
          h('span', { className: 'dh-seg-out', style: { width: pctOf(outputTok) }, title: `输出 ${dhNum(outputTok)}` })) : null,
        h('div', { className: 'dh-stat-grid' }, [
          ['未缓存输入', `${dhNum(uncachedIn)} tok`, 'dh-seg-in'],
          ['缓存读取', `${dhNum(cacheRead)} tok`, 'dh-seg-read'],
          ['缓存写入', `${dhNum(cacheWrite)} tok`, 'dh-seg-write'],
          ['输出', `${dhNum(outputTok)} tok`, 'dh-seg-out'],
          ['请求次数', dhNum(totals.requests), null],
          ['未计价请求', dhNum(totals.unpricedRequests), null],
          ['未返回用量请求', dhNum(totals.unmeteredRequests), null],
        ].map(([label, val, swatch]) => h('div', { key: label, className: 'dh-stat-cell' },
          h('span', { className: 'dh-stat-label' }, swatch ? h('i', { className: `dh-swatch ${swatch}` }) : null, label),
          h('strong', { className: 'dh-stat-val' }, val)))))),
      h('div', { className: 'dh-table-card' },
        h('div', { className: 'dh-table-head' }, h('h3', null, '按 Agent 统计')),
        h('div', { className: 'dh-table-wrap' },
          h('table', null,
            h('thead', null, h('tr', null, ['Agent', '输入', '缓存读取', '缓存写入', '输出', 'API 价值'].map(label => h('th', { key: label }, label)))),
            h('tbody', null, (s.data.byHarness ?? []).filter(r => ['codex', 'claude-code', 'antigravity', 'deepseek-harness'].includes(r.harness)).map(r =>
              h('tr', { key: r.harness },
                h('td', null, dhAgent(r.harness)),
                ...[r.inputTokens, r.cachedInputTokens, r.cacheWriteInputTokens, r.outputTokens].map((n, i) => h('td', { key: i }, dhNum(n))),
                h('td', { className: 'dh-td-money' }, dhMoney(r.costUsd))))))))) : null,
    h('p', { className: 'dh-note' }, '金额复用原 Host 的 API 单价与缓存计价。未计价请求不计入美元总额。这里显示原生 Agent 的记录，不会额外调用模型。'),
    h(DhPrices, { remote, onSaved: reload }))
}

function DhPrices({ remote, onSaved }) {
  const [s, reload] = useConsoleData(remote, { action: 'prices' }), [model, setModel] = useState(''), [price, setPrice] = useState({}), [previousKey, setPreviousKey] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const fields = [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入（5 分钟）'], ['cacheWrite1h', '缓存写入（1 小时）']]
  const validPrice = ['input', 'output'].every(key => price[key] !== undefined && price[key] !== '') && fields.every(([key]) => price[key] === undefined || price[key] === '' || (Number.isFinite(Number(price[key])) && Number(price[key]) >= 0))
  const lookup = async () => { setBusy(true); setMessage(''); try { const r = dhReply(await remote.request({ action: 'priceDefault', model: model.trim() })); setPrice(r.price ?? {}); setMessage(r.price ? '已读取原 Host 默认单价。' : '原 Host 没有此模型的默认单价，请填写自定义单价。') } catch (e) { setMessage(e.message) } finally { setBusy(false) } }
  const save = async remove => { setBusy(true); setMessage(''); try { const p = Object.fromEntries(fields.filter(([key]) => price[key] !== undefined && price[key] !== '').map(([key]) => [key, Number(price[key])]))
    dhReply(await remote.request({ action: 'priceSave', key: model.trim(), ...(previousKey ? { previousKey } : {}), price: remove ? null : p })); setMessage(remove ? '已恢复默认单价。' : 'API 单价已保存，统计将重新计算。'); setPreviousKey(remove ? null : model.trim()); reload(); onSaved() } catch (e) { setMessage(e.message) } finally { setBusy(false) } }
  return h('details', { className: 'dh-price-editor' },
    h('summary', null, h('span', null, '自定义 API 单价'), (s.data?.entries?.length ?? 0) > 0 ? h('span', { className: 'dh-count-pill' }, s.data.entries.length) : null),
    h('div', { className: 'dh-price-body' },
      h('p', { className: 'dh-note' }, '单位：美元 / 百万 Token。精确匹配原生模型 ID；只修改费用估算，不修改上游账单。缓存价格留空表示未配置。'),
      dhFeedback(s), s.data?.error ? h('p', { className: 'dh-inline-alert dh-error' }, s.data.error) : null,
      (s.data?.entries?.length ?? 0) > 0 ? h('div', { className: 'dh-price-chips' }, s.data.entries.map(row => dhButton(row.key, () => { setModel(row.key); setPrice(row.price); setPreviousKey(row.key); setMessage('') }, { key: row.key, disabled: busy, className: previousKey === row.key ? 'dh-chip-active' : '' }))) : null,
      h('div', { className: 'dh-field' }, h('label', { htmlFor: 'dh-price-model' }, '模型 ID'), h('input', { id: 'dh-price-model', value: model, disabled: busy, onChange: e => { setModel(e.target.value); setPreviousKey(null) }, placeholder: '填写原生模型 ID，例如 gemini-4-neon' })),
      h('div', { className: 'dh-price-fields' }, fields.map(([key, label]) => h('label', { key }, label, h('input', { type: 'number', min: 0, step: 'any', value: price[key] ?? '', placeholder: '0.00', onChange: e => setPrice(p => ({ ...p, [key]: e.target.value })), disabled: busy })))),
      h('div', { className: 'dh-actions' }, dhButton('读取默认价', lookup, { disabled: busy || !model.trim() }), dhButton('保存单价', () => save(false), { className: 'dh-primary', disabled: busy || !model.trim() || !validPrice || s.loading || !!s.error || !!s.data?.error }), previousKey ? dhButton('恢复默认', () => save(true), { disabled: busy || s.loading || !!s.error || !!s.data?.error }) : null),
      message ? h('p', { role: 'status', className: 'dh-field-msg' }, message) : null))
}

export const dshConsoleCss = `
.dh-console-trigger{display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:44px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.dh-console-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dh-console-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"]){display:grid;grid-template-columns:minmax(0,1fr) 44px 36px;align-items:center;column-gap:4px}
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"])>[class*="_settingsArea"]{grid-row:2;grid-column:1;min-width:0;width:auto;box-sizing:border-box;padding-right:0!important}
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"])>[class*="_footerActions"]{display:contents!important}
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"]) .usg_layer{grid-row:1;grid-column:1/-1;min-width:0;width:100%;margin:4px 0}
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"]) .dsh-mobile-control__trigger:not(.is-rail){grid-row:2;grid-column:2}
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"]) .dh-console-trigger[data-wide="true"]{grid-row:2;grid-column:3}
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"])>[class*="_footerActions"] .dsh-mobile-control__trigger:not(.is-rail),
[class*="_footArea"]:has(.dh-console-trigger[data-wide="true"])>[class*="_footerActions"] .dh-console-trigger[data-wide="true"]{position:static!important;inset:auto!important;flex-shrink:0}
.dh-console{
  height:100%;min-height:0;overflow:auto;container-type:inline-size;scrollbar-gutter:stable;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;font-size:14px;
  --dh-line:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,#8883));
  --dh-surface:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04)));
  --dh-surface-alt:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07)));
  --dh-accent:var(--dsw-alias-state-business-primary,#467aff);
  --dh-accent-soft:var(--dsw-alias-state-business-tertiary,rgba(70,122,255,.12));
  --dh-ok:var(--dsw-alias-state-success-primary,#16a34a);
  --dh-ok-soft:var(--dsw-alias-state-success-tertiary,rgba(22,163,74,.12));
  --dh-warn:var(--dsw-alias-state-warn-primary,#d97706);
  --dh-warn-soft:var(--dsw-alias-state-warn-tertiary,rgba(217,119,6,.12));
  --dh-err:var(--dsw-alias-state-error-primary,#dc2626);
  --dh-err-soft:var(--dsw-alias-state-error-secondary,rgba(220,38,38,.1))
}
.dh-console *{box-sizing:border-box}
.dh-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px 32px 18px max(32px,var(--dsh-frame-leading-clearance,0px))}
.dh-header-lead{display:flex;align-items:center;gap:14px;min-width:0}
.dh-brand-mark{width:40px;height:40px;border-radius:11px;display:inline-flex;align-items:center;justify-content:center;flex:none;background:var(--dh-accent-soft);color:var(--dh-accent);border:1px solid color-mix(in srgb,var(--dh-accent) 22%,transparent)}
.dh-brand{display:flex;align-items:center;gap:10px}
.dh-console h1{font-size:21px;line-height:28px;margin:0;font-weight:650;letter-spacing:-.2px}
.dh-console h2{font-size:18px;line-height:26px;margin:0;font-weight:600;letter-spacing:-.1px}
.dh-console h3{font-size:14px;font-weight:600;margin:0 0 12px}
.dh-console p{line-height:1.65;margin:8px 0;color:var(--dsw-alias-label-secondary)}
.dh-header p,.dh-sub{margin:3px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dh-chip{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);padding:5px 11px;border:1px solid var(--dh-line);border-radius:999px;background:var(--dh-surface)}
.dh-dot{width:7px;height:7px;border-radius:999px;display:inline-block;flex:none;background:var(--dsw-alias-label-tertiary,#888)}
.dh-dot-ok{background:var(--dh-ok);box-shadow:0 0 0 3px var(--dh-ok-soft)}
.dh-dot-warn{background:var(--dh-warn);box-shadow:0 0 0 3px var(--dh-warn-soft)}
.dh-status-inline{display:inline-flex;align-items:center;gap:9px}
.dh-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dh-line);padding:0 32px;overflow-x:auto;position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base,#fff);backdrop-filter:blur(8px)}
.dh-tab-label{display:inline-flex;align-items:center;gap:7px}
.dh-tab-ico{flex:none;opacity:.82}
.dh-console button,.dh-console input,.dh-console select{font:inherit;color:inherit}
.dh-console button{border:1px solid var(--dh-line);border-radius:var(--dsw-radius-sm,8px);background:transparent;padding:7px 12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s,box-shadow .15s,opacity .15s}
.dh-console button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8881);border-color:color-mix(in srgb,var(--dh-line) 70%,var(--dsw-alias-label-primary) 30%)}
.dh-console button:disabled{opacity:.45;cursor:default}
.dh-console :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dh-accent));outline-offset:2px}
.dh-tabs button{height:44px;box-shadow:none;border:0;border-radius:8px 8px 0 0;border-bottom:2px solid transparent;padding:10px 12px;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-weight:500}
.dh-tabs button[aria-current=page]{border-bottom-color:var(--dh-accent);color:var(--dh-accent);font-weight:600}
.dh-tabs button[aria-current=page] .dh-tab-ico{opacity:1}
.dh-body{width:100%;max-width:1160px;padding:24px 32px 44px;margin:0 auto}
.dh-section-title{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.dh-toolbar-right{margin:0;align-items:center}
.dh-updated{font-size:12px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap}
.dh-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:16px 0 20px}
.dh-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:18px 0}
.dh-card{border:1px solid var(--dh-line);border-radius:var(--dsw-radius-lg,14px);padding:20px;min-width:0;background:var(--dh-surface);display:flex;flex-direction:column;transition:border-color .18s,box-shadow .18s}
.dh-card:hover{border-color:color-mix(in srgb,var(--dh-line) 65%,var(--dsw-alias-label-secondary) 35%);box-shadow:var(--dsw-shadow-lv1,0 2px 10px rgba(0,0,0,.04))}
.dh-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}
.dh-card-head h3{margin:0}
.dh-card-body{display:flex;flex-direction:column;flex:1;min-width:0}
.dh-card-foot{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:16px}
.dh-card p{font-size:13px}
.dh-metrics .dh-card{padding:18px 20px}
.dh-metrics h3{color:var(--dsw-alias-label-secondary);margin-bottom:10px;font-size:12px;font-weight:550;letter-spacing:.2px}
.dh-value{display:block;font-size:26px;line-height:1.3;font-weight:650;letter-spacing:-.4px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dh-value-accent{color:var(--dh-accent)}
.dh-metric-note{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dh-agent{display:inline-flex;align-items:center;gap:9px;font-weight:600;min-width:0}
.dh-agent-badge{width:30px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex:none;background:var(--dsw-alias-bg-base);border:1px solid var(--dh-line)}
.dh-agent img{object-fit:contain;flex:none}
.dh-tags{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}
.dh-tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dh-surface-alt);border:1px solid var(--dh-line);white-space:nowrap}
.dh-tag-accent{color:var(--dh-accent);background:var(--dh-accent-soft);border-color:color-mix(in srgb,var(--dh-accent) 25%,transparent)}
.dh-tag-warn{color:var(--dh-warn);background:var(--dh-warn-soft);border-color:color-mix(in srgb,var(--dh-warn) 25%,transparent)}
.dh-note{font-size:12.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:14px 0}
.dh-state{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;background:var(--dh-surface-alt);font-size:12px;font-weight:550;white-space:nowrap;flex:none}
.dh-ready{color:var(--dh-ok);background:var(--dh-ok-soft)}
.dh-warn{color:var(--dh-warn);background:var(--dh-warn-soft)}
.dh-pairs{margin:6px 0 0;font-size:13px}
.dh-pairs>div{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px dashed color-mix(in srgb,var(--dh-line) 75%,transparent)}
.dh-pairs>div:last-child{border-bottom:0}
.dh-pairs dt{color:var(--dsw-alias-label-secondary);flex-shrink:0}
.dh-pairs dd{margin:0;overflow-wrap:anywhere;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dh-subpanel{margin:14px 0 4px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dh-line)}
.dh-field{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin:14px 0}
.dh-field label{font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-secondary)}
.dh-field-row{display:flex;gap:8px;align-items:center}
.dh-field-row input{flex:1}
.dh-field-msg{margin:4px 0 0;font-size:12px;color:var(--dh-accent)}
.dh-console input:not([type=checkbox]),.dh-console select{min-width:0;border:1px solid var(--dh-line);border-radius:var(--dsw-radius-sm,8px);padding:8px 11px;background:var(--dsw-alias-bg-base);transition:border-color .15s,box-shadow .15s}
.dh-console input:not([type=checkbox]):focus,.dh-console select:focus{border-color:var(--dh-accent);outline:none;box-shadow:0 0 0 3px var(--dh-accent-soft)}
.dh-details{margin-top:auto;padding-top:12px}
.dh-console details{margin-top:14px}
.dh-console summary{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:550;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dh-line);list-style:none}
.dh-console summary::-webkit-details-marker{display:none}
.dh-console summary:hover{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dh-line) 65%,var(--dsw-alias-label-secondary) 35%)}
.dh-count-pill{padding:1px 8px;border-radius:999px;font-size:11px;font-variant-numeric:tabular-nums;background:var(--dh-surface-alt);color:var(--dsw-alias-label-secondary)}
.dh-models{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:10px 0 0;padding:2px 0;max-height:200px;overflow:auto}
.dh-models li{font-size:12px;padding:4px 9px;border-radius:7px;background:var(--dsw-alias-bg-base);border:1px solid var(--dh-line);color:var(--dsw-alias-label-primary)}
.dh-muted-box{margin:12px 0 0;padding:11px 12px;border-radius:9px;background:var(--dsw-alias-bg-base);border:1px dashed var(--dh-line);font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dh-inline-alert{margin:0 0 10px;padding:9px 11px;border-radius:9px;background:var(--dh-err-soft);border:1px solid color-mix(in srgb,var(--dh-err) 25%,transparent);font-size:12.5px}
.dh-feedback{display:flex;align-items:center;gap:10px;margin:12px 0;padding:11px 14px;border:1px solid var(--dh-line);border-radius:10px;background:var(--dh-surface);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
.dh-error{color:var(--dh-err)!important;border-color:color-mix(in srgb,var(--dh-err) 35%,transparent)!important;background:var(--dh-err-soft)}
.dh-spinner{width:14px;height:14px;border-radius:999px;border:2px solid var(--dh-line);border-top-color:var(--dh-accent);animation:dh-spin .75s linear infinite;flex:none}
@keyframes dh-spin{to{transform:rotate(360deg)}}
.dh-credits-box{margin-top:12px;padding:12px;border-radius:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dh-line)}
.dh-meter{margin-bottom:8px}
.dh-meter-head{display:flex;align-items:baseline;justify-content:space-between;font-size:12.5px;margin-bottom:6px;color:var(--dsw-alias-label-secondary)}
.dh-meter-head strong{font-size:14px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dh-meter-track{height:7px;border-radius:999px;background:var(--dh-surface-alt);overflow:hidden}
.dh-meter-mini{margin-top:10px;height:6px}
.dh-meter-fill{height:100%;border-radius:999px;background:var(--dh-accent);transition:width .25s ease}
.dh-bar-ok{background:var(--dh-ok)}
.dh-bar-warn{background:var(--dh-warn)}
.dh-bar-danger{background:var(--dh-err)}
.dh-guide{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px;padding:22px 24px;border:1px solid var(--dh-line);border-radius:var(--dsw-radius-lg,14px);background:var(--dh-surface)}
.dh-guide h3{margin-bottom:12px}
.dh-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.dh-steps li{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dh-step-num{width:22px;height:22px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;flex:none;font-size:12px;font-weight:650;background:var(--dh-accent-soft);color:var(--dh-accent)}
.dh-guide p{font-size:13px;margin:0 0 8px}
.dh-import-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 0 18px}
.dh-segment{display:inline-flex;padding:4px;gap:3px;border:1px solid var(--dh-line);border-radius:11px;background:var(--dh-surface-alt)}
.dh-segment button{height:34px;box-shadow:none;border:0;border-radius:8px;padding:0 12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dh-segment button[aria-pressed=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1,0 1px 3px rgba(0,0,0,.08));font-weight:600}
.dh-search{display:flex;gap:8px;flex:1;min-width:240px;max-width:460px}
.dh-search input{flex:1}
.dh-search-btn{padding:8px 14px;font-weight:550;background:var(--dh-surface)}
.dh-session-list{display:flex;flex-direction:column;gap:10px;margin-top:16px}
.dh-session{padding:15px 18px;display:flex;align-items:center;gap:18px;border:1px solid var(--dh-line);border-radius:12px;background:var(--dh-surface);transition:border-color .15s,background .15s}
.dh-session:hover{border-color:color-mix(in srgb,var(--dh-line) 55%,var(--dh-accent) 45%);background:color-mix(in srgb,var(--dh-surface) 92%,var(--dh-accent) 8%)}
.dh-session-active{border-color:var(--dh-accent)!important;box-shadow:0 0 0 2px var(--dh-accent-soft)}
.dh-session-copy{min-width:0;flex:1}
.dh-session-top{display:flex;align-items:center;gap:8px;min-width:0}
.dh-session strong{display:block;flex:0 1 auto;min-width:0;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dh-session-top .dh-tag{flex:none}
.dh-path{overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:12px;margin:5px 0}
.dh-session small{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px}
.dh-empty{padding:44px 16px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dh-line);border-radius:12px;background:var(--dh-surface)}
.dh-import-confirm{padding:18px 20px;border:1px solid var(--dh-accent);border-radius:14px;margin:16px 0;background:color-mix(in srgb,var(--dh-accent-soft) 55%,var(--dsw-alias-bg-base))}
.dh-confirm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.dh-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.65;margin:10px 0 0;cursor:pointer}
.dh-check input{margin-top:4px;accent-color:var(--dh-accent)}
.dh-import-result{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 16px;margin:14px 0;border:1px solid color-mix(in srgb,var(--dh-ok) 35%,transparent);border-radius:12px;background:var(--dh-ok-soft)}
.dh-import-result span{min-width:0;overflow-wrap:anywhere;font-weight:550}
.dh-import-result button{flex-shrink:0}
.dh-actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
.dh-console button.dh-primary{background:var(--dh-accent);color:#fff;border-color:transparent;font-weight:550}
.dh-console button.dh-primary:hover:not(:disabled){filter:brightness(.94);background:var(--dh-accent);border-color:transparent}
.dh-filter-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:12px 0 16px}
.dh-range-pills button{height:30px;padding:0 10px;font-size:12.5px}
.dh-stack-bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--dh-surface-alt);margin:4px 0 16px;gap:2px}
.dh-seg-read{background:#16a34a}
.dh-seg-write{background:#f59e0b}
.dh-seg-in{background:#467aff}
.dh-seg-out{background:#8b5cf6}
.dh-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.dh-stat-cell{padding:11px 12px;border-radius:10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dh-line);display:flex;flex-direction:column;gap:5px;min-width:0}
.dh-stat-label{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dh-stat-val{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.dh-swatch{width:8px;height:8px;border-radius:3px;display:inline-block;flex:none}
.dh-table-card{margin:18px 0;border:1px solid var(--dh-line);border-radius:var(--dsw-radius-lg,14px);background:var(--dh-surface);overflow:hidden}
.dh-table-head{padding:14px 20px;border-bottom:1px solid var(--dh-line)}
.dh-table-head h3{margin:0}
.dh-table-wrap{overflow:auto}
.dh-console table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}
.dh-console th,.dh-console td{padding:12px 16px;text-align:right;border-bottom:1px solid var(--dh-line);font-variant-numeric:tabular-nums}
.dh-console tbody tr:last-child td{border-bottom:0}
.dh-console tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.05))}
.dh-console th{font-weight:550;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dh-console th:first-child,.dh-console td:first-child{text-align:left;padding-left:20px}
.dh-console th:last-child,.dh-console td:last-child{padding-right:20px}
.dh-td-money{font-weight:600;color:var(--dh-accent)}
.dh-price-editor{margin-top:20px;border:1px solid var(--dh-line);border-radius:var(--dsw-radius-lg,14px);background:var(--dh-surface);padding:4px}
.dh-price-editor>summary{border:0;background:transparent;padding:12px 16px}
.dh-price-body{padding:4px 16px 16px;border-top:1px solid var(--dh-line)}
.dh-price-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px}
.dh-chip-active{border-color:var(--dh-accent)!important;background:var(--dh-accent-soft)!important;color:var(--dh-accent)!important;font-weight:600}
.dh-price-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:10px 0}
.dh-price-fields label{display:flex;flex-direction:column;gap:6px;font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-secondary)}
.dh-header-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dh-chip-update{border-color:color-mix(in srgb,var(--dh-warn) 45%,transparent)!important;background:var(--dh-warn-soft)!important;color:var(--dh-warn)!important}
.dh-update-wrap{padding:14px 32px 0;max-width:1180px;margin:0 auto;width:100%}
.dh-update-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:13px 18px;border:1px solid color-mix(in srgb,var(--dh-accent) 40%,transparent);border-radius:12px;background:color-mix(in srgb,var(--dh-accent-soft) 70%,var(--dsw-alias-bg-base))}
.dh-update-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dh-update-copy strong{font-size:13.5px;color:var(--dsw-alias-label-primary)}
.dh-update-copy span{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dh-update-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dh-link-btn{font-size:12.5px;color:var(--dh-accent);text-decoration:none;font-weight:550}
.dh-link-btn:hover{text-decoration:underline}
@container(max-width:960px){.dh-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dh-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container(max-width:720px){.dh-body{padding:20px 18px 32px}.dh-grid,.dh-guide{grid-template-columns:1fr}.dh-metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.dh-metrics .dh-card{padding:14px}.dh-value{font-size:22px}.dh-price-fields{grid-template-columns:repeat(2,minmax(0,1fr))}.dh-chip{display:none}.dh-import-result{align-items:flex-start;flex-direction:column}.dh-header{padding:18px 18px 14px max(18px,var(--dsh-frame-leading-clearance,0px))}.dh-tabs{padding:0 14px}.dh-tabs button{font-size:13px;padding:10px 8px}.dh-session{align-items:flex-start}.dh-search{max-width:none}}
@container(max-width:460px){.dh-metrics{grid-template-columns:1fr}.dh-stat-grid{grid-template-columns:1fr}.dh-body{padding:16px 12px 26px}.dh-card{padding:15px}.dh-updated{display:none}.dh-pairs>div{flex-wrap:wrap;gap:4px}.dh-pairs dd{text-align:left;width:100%}.dh-segment{display:flex;width:100%}.dh-segment button{flex:1}}
@media(prefers-reduced-motion:reduce){.dh-console button,.dh-card,.dh-meter-fill,.dh-spinner{transition:none;animation:none}}
`
