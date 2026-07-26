// sessionsView.js — 统一会话空间(chat + PTY 终端合列,本轮旗舰屏)。
//   并拉两族数据 + 四态徽标 → sessionsState 归一/分组 → 时间轴列表。
//   页面活跃时 8s 轮询;离开 tab 停,回来立即刷。新建走零配置 sheet(见 §7b)。
//   只做 DOM 与 API;所有归一/分组/排序在 sessionsState.js。跳转一律 router.open。
// 契约导出:init() / load()(见 §9)。
// V2 蓝图精制波二(2026-07-19):页头下 lg-filterbar(搜索虚线皮 + 状态 seg 计数 + 来源 picker,
//   客户端过滤不改 API);副行默认收起,行尾 ⓘ 出底部 sheet(hover 设备另有悬浮预览);
//   状态改 lg-badge、时间改 lg-dim;「选择」批量模式(行首 check + dockbar,删除 danger 隔离)。

import { api, apiJson, esc, toast, store, confirmModal, promptModal } from './core.js'
import {
  largeHeader, listRow, emptyState, fab, openSheet, openMenu, icons,
  segmented, tagPicker, bindRowPreview,
} from './ui.js'
import * as router from './router.js'
import {
  normalizeSessions, groupRows, filterRows, historySessionTitle,
  providerKey, tailCwd, relTime,
} from './sessionsState.js'

const LAST_NEW_KEY = 'lofa.lastNewSession'
const POLL_MS = 8000
// cwd 固定为 WindowsWorkspace(§7b 简化:新建 sheet 不再让用户选目录)。
const FIXED_CWD = 'E:/WindowsWorkspace'

// 新建类型清单:对话族 → POST /api/cc/chat/sessions;终端族 → POST /api/cc/sessions。
const NEW_TYPES = [
  { id: 'chat_claude', group: 'chat', label: 'Claude 对话', provider: 'claude_code' },
  { id: 'chat_codex', group: 'chat', label: 'Codex 对话', provider: 'codex' },
  { id: 'chat_omni', group: 'chat', label: 'Omni 对话', provider: 'omni_agent' },
  { id: 'chat_kimi', group: 'chat', label: 'Kimi 对话', provider: 'kimi' },
  { id: 'chat_opencode', group: 'chat', label: 'OpenCode 对话', provider: 'opencode' },
  { id: 'term_claude', group: 'term', label: 'Claude CLI', cmd: null },
  { id: 'term_codex', group: 'term', label: 'Codex CLI', cmd: ['codex'] },
  { id: 'term_kimi', group: 'term', label: 'Kimi CLI', cmd: ['kimi'] },
  { id: 'term_opencode', group: 'term', label: 'OpenCode CLI', cmd: ['opencode'] },
  { id: 'term_shell', group: 'term', label: 'PowerShell', cmd: ['powershell'] },
]
const TYPE_BY_ID = NEW_TYPES.reduce((m, t) => (m[t.id] = t, m), {})

let _scroll = null, _head = null, _list = null
let _rows = []          // 最近一次归一结果(供搜索/筛选复用)
let _query = ''
let _seg = 'all'        // 状态 seg:wait 待输入 / recover 可续接 / all 全部
let _srcs = new Set()   // 来源 picker 多选(空=全部)
let _moreOpen = false   // 「更早」组渐进披露开关
let _batch = { mode: false, ids: new Set() }
let _segCtl = null, _srcCtl = null
let _fab = null
let _timer = null
let _visBound = false

// 来源桶(与 demo 6 类对齐):omni 及未知归「其他」。
const SRC_BUCKETS = [['claude', 'Claude'], ['codex', 'Codex'], ['kimi', 'Kimi'], ['opencode', 'OpenCode'], ['term', '终端'], ['other', '其他']]
function srcBucket(provider) {
  const k = providerKey(provider)
  return SRC_BUCKETS.some(([b]) => b === k) ? k : 'other'
}

// ── 生命周期 ──────────────────────────────────────────────────────────────────
export function init() {
  const v = document.getElementById('sessionsView'); v.innerHTML = ''
  _head = largeHeader({ title: '会话' })
  // 页头下 filterbar(蓝图工具行):搜索虚线测量皮 + 状态 seg(真实计数) + 来源 picker + 「选择」。
  const fb = document.createElement('div'); fb.className = 'lg-filterbar'; fb.id = 'sessionsFilter'
  fb.innerHTML =
    '<label class="lg-fb-search">' + icons.search +
    '<input type="search" id="sessionsSearch" placeholder="搜索标题或目录" autocapitalize="off" autocorrect="off" spellcheck="false"></label>' +
    '<div id="sessionsSeg"></div>' +
    '<div class="ss-tools"><div id="sessionsSrc"></div>' +
    '<button class="lg-btn ghost ss-select" id="sessionsSelect">选择</button></div>'
  // 头部+filterbar 随内容滚动:放进滚动容器顶部,与列表一起滚走(§6 反馈 1)。
  _scroll = document.createElement('div'); _scroll.className = 'scroll'; _scroll.id = 'sessionsList'
  _list = document.createElement('div'); _list.className = 'lg-list'
  _scroll.appendChild(_head.el); _scroll.appendChild(fb); _scroll.appendChild(_list)
  const f = fab({ id: 'fabNew', onTap: openNewSheet })
  _fab = f
  const bar = document.createElement('div'); bar.className = 'lg-dockbar'; bar.id = 'sessionsActions'
  v.appendChild(_scroll); v.appendChild(f); v.appendChild(bar)
  fb.querySelector('#sessionsSearch').addEventListener('input', (e) => { _query = e.target.value || ''; renderList() })
  fb.querySelector('#sessionsSelect').addEventListener('click', toggleBatch)
  _segCtl = segmented(fb.querySelector('#sessionsSeg'), {
    options: segOptions(), value: _seg,
    onChange: (val) => { _seg = val; renderList() },
  })
  _srcCtl = tagPicker(fb.querySelector('#sessionsSrc'), {
    label: '来源', options: srcOptions(),
    onChange: (vals) => { _srcs = new Set(vals); renderList() },
  })
  bindVisibility()
}

// seg/picker 选项计数:全部来自最新 _rows(客户端过滤,不改 API)。
function segOptions() {
  let wait = 0, recover = 0
  _rows.forEach((r) => { if (r.status === 'waiting') wait++; else if (r.status === 'recoverable') recover++ })
  return [
    { value: 'wait', label: '待输入', count: wait },
    { value: 'recover', label: '可续接', count: recover },
    { value: 'all', label: '全部', count: _rows.length },
  ]
}
function srcOptions() {
  const counts = {}
  _rows.forEach((r) => { const b = srcBucket(r.provider); counts[b] = (counts[b] || 0) + 1 })
  return SRC_BUCKETS.map(([value, label]) => ({ value, label, count: counts[value] || 0 }))
}
function syncFilterCounts() {
  if (_segCtl) _segCtl.setOptions(segOptions())
  if (_srcCtl) _srcCtl.setOptions(srcOptions())
}

// 进入会话 tab:立即刷 + 起轮询。router.onChange 在离开时不回调本模块,靠可见性与 tab 判断收敛。
export function load() {
  if (!store.base) return
  refresh()
  startPoll()
}

function bindVisibility() {
  if (_visBound || typeof document === 'undefined') return
  _visBound = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPoll()
    else if (isActiveTab()) { refresh(); startPoll() }
  })
}
function isActiveTab() { return router.current() === 'sessionsView' && !document.hidden }
function startPoll() { if (_timer) return; _timer = setInterval(() => { if (isActiveTab()) refresh(); else stopPoll() }, POLL_MS) }
function stopPoll() { if (_timer) { clearInterval(_timer); _timer = null } }

// ── 拉数并归一 ────────────────────────────────────────────────────────────────
async function refresh() {
  if (!store.base) return
  try {
    const [chat, pty, active] = await Promise.all([
      api('/api/cc/chat/sessions').catch(() => ({ items: [] })),
      api('/api/cc/sessions?include_recoverable=true').catch(() => ({ items: [] })),
      // 窗口放宽到 7 天:非活跃会话也拿得到 digest 中文主题与最后活动时间
      api('/api/cc/chat/active?window_sec=315360000&limit=500').catch(() => ({})),
    ])
    const chatItems = (chat && chat.items) || []
    const ptyAlive = (pty && pty.items) || []
    const ptyRecoverable = ((pty && pty.recoverable) || []).map((r) => Object.assign({ __recoverable: true }, r))
    _rows = normalizeSessions(chatItems, ptyAlive.concat(ptyRecoverable), active)
    syncFilterCounts()
    renderList()
    fillWeakTitles(_rows)   // 弱标题懒补全,不阻塞渲染
  } catch (e) { /* 断线由全局 banner 反映;保留上次列表 */ }
}

// ── 列表渲染(客户端过滤:搜索 + 状态 seg + 来源多选;不改 API) ─────────────────
function applyFilters() {
  let rows = filterRows(_rows, _query)
  if (_seg === 'wait') rows = rows.filter((r) => r.status === 'waiting')
  else if (_seg === 'recover') rows = rows.filter((r) => r.status === 'recoverable')
  if (_srcs.size) rows = rows.filter((r) => _srcs.has(srcBucket(r.provider)))
  return rows
}
function renderList() {
  if (!_list) return
  _list.innerHTML = ''
  const rows = applyFilters()
  if (!rows.length) {
    _list.appendChild(emptyState({
      icon: icons.chat,
      title: (_query || _seg !== 'all' || _srcs.size) ? '没有匹配的会话' : '还没有会话',
      hint: (_query || _seg !== 'all' || _srcs.size) ? '清空筛选条件试试' : '点右下角加号新建对话或终端',
      action: (_query || _seg !== 'all' || _srcs.size) ? null : { label: '新建', onTap: openNewSheet },
    }))
    return
  }
  // 「更早」组渐进披露:无筛选时默认 6 条 + 展开钮(demo 同);有筛选即全量。
  const filtering = !!(_query.trim() || _seg !== 'all' || _srcs.size)
  groupRows(rows, Date.now()).forEach((sec) => {
    const collapsed = sec.key === 'older' && !filtering && !_moreOpen && sec.rows.length > 6
    const h = document.createElement('div'); h.className = 'lg-sec-head'
    h.innerHTML = esc(sec.title) + '<span class="lg-count ss-sec-n">' + sec.rows.length + '</span>'
    _list.appendChild(h)
    ;(collapsed ? sec.rows.slice(0, 6) : sec.rows).forEach((r) => _list.appendChild(buildRow(r)))
    if (collapsed) {
      const more = document.createElement('div'); more.className = 'ss-more'
      more.innerHTML = '<button>' + icons.chevD + '展开更早 · 还有 ' + (sec.rows.length - 6) + ' 条</button>'
      more.querySelector('button').addEventListener('click', () => { _moreOpen = true; renderList() })
      _list.appendChild(more)
    }
  })
}

// 行尾侧栈:lg-dim 短格式时间 + lg-badge 状态徽章(副行收起后只留扫读必需)。
function dimHtml(t) { return '<span class="lg-dim"><i></i><b>' + esc(t) + '</b><i></i></span>' }
function badgeHtml(status) {
  if (status === 'waiting') return '<span class="lg-badge st-ok"><i class="led"></i>待输入</span>'
  if (status === 'recoverable') return '<span class="lg-badge st-hollow"><i class="led"></i>可续接</span>'
  if (status === 'running') return '<span class="lg-badge st-seal"><i class="led"></i>在跑</span>'
  return ''
}
function sideHtml(r) {
  return dimHtml(relTime(r.lastActive, Date.now()) || '—') + badgeHtml(r.status)
}
// hover 预览卡内容(hover 设备;触屏等价 = ⓘ 底部 sheet,内容同源)。
function previewHtml(r, title) {
  return '<div class="pv-t">' + badgeHtml(r.status) + '<span>' + esc(title) + '</span></div>' +
    '<div class="pv-d">' + esc(r.identity) + (r.kind === 'term' ? ' · 终端' : ' · 对话') + '</div>' +
    '<div class="pv-meta"><span>' + esc(r.cwd || '—') + '</span><span>' + esc(relTime(r.lastActive, Date.now()) || '—') + '</span></div>'
}

// 终端本地展示名(改名存本地,与终端屏共用键)。
function getTermName(id) { try { return localStorage.getItem('lofa.termName.' + id) || '' } catch (e) { return '' } }

// ── 弱标题懒补全:/active 有 80 条上限,agent transcript 多时老会话拿不到 preview。
// 对 titleWeak 行懒取一次 history 首条用户消息,localStorage 永久缓存(标题不会变)。
// Backfill every weak legacy title. Old persistent titleTried flags are intentionally ignored.
const TITLE_CACHE = 'lofa.title.'
const _titleLoading = new Set()
const _titleDone = new Set()
const _titleRetryAt = new Map()
function cachedTitle(id) { try { return localStorage.getItem(TITLE_CACHE + id) || '' } catch (e) { return '' } }
function saveCachedTitle(id, t) { try { localStorage.setItem(TITLE_CACHE + id, t) } catch (e) {} }
async function fillWeakTitles(rows) {
  const now = Date.now()
  const need = (rows || []).filter((r) => r.kind === 'chat' && r.titleWeak && !cachedTitle(r.id) && !_titleDone.has(r.id) && !_titleLoading.has(r.id) && (_titleRetryAt.get(r.id) || 0) <= now)
  if (!need.length) return
  need.forEach((r) => _titleLoading.add(r.id))
  let cursor = 0
  const worker = async () => {
    while (cursor < need.length) {
      const r = need[cursor++]
      try {
        const h = await api('/api/cc/chat/sessions/' + encodeURIComponent(r.id) + '/history')
        const title = historySessionTitle(h)
        if (title) saveCachedTitle(r.id, title)
        _titleDone.add(r.id)
      } catch (e) { _titleRetryAt.set(r.id, Date.now() + 60000) }
      finally { _titleLoading.delete(r.id); renderList() }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, need.length) }, worker))
}

function rowTitle(r) {
  return r.kind === 'term' ? (getTermName(r.id) || r.title)
    : ((r.titleWeak && cachedTitle(r.id)) || r.title)
}
function buildRow(r) {
  const title = rowTitle(r)
  const stKey = { waiting: 'wait', recoverable: 'recover', running: 'run' }[r.status] || ''
  // 副行(目录/来源)留在 DOM 但默认 CSS 隐藏(少字);完整信息进 ⓘ sheet / hover 预览。
  const sub = [r.identity, tailCwd(r.cwd), relTime(r.lastActive, Date.now())].filter(Boolean).join(' · ')
  const row = listRow({
    icon: r.kind === 'term' ? icons.term : icons.chat,
    iconClass: 'pv-' + providerKey(r.provider),
    title,
    sub,
    side: sideHtml(r),
    info: true,
    dataSt: stKey,
    onTap: (e) => {
      if (e.target.closest('.lr-info')) return openInfoSheet(r)
      if (_batch.mode) return togglePick(r, row)
      openRow(r)
    },
    onLongPress: (e) => openRowMenu(r, e && e.target),
  })
  // 行左缘状态色条(demo .lr-bar 同源);批量模式行首 check 在其前。
  row.insertAdjacentHTML('afterbegin', '<span class="ss-bar" data-st="' + stKey + '" aria-hidden="true"></span>')
  if (_batch.mode) {
    row.classList.toggle('picked', _batch.ids.has(r.id))
    row.insertAdjacentHTML('afterbegin',
      '<span class="lg-check ss-cb" aria-checked="' + (_batch.ids.has(r.id) ? 'true' : 'false') + '"><span class="cb">' + icons.check + '</span></span>')
  }
  const titleEl = row.querySelector('.lg-row-title')
  if (titleEl && r.identity) titleEl.insertAdjacentHTML('beforeend', '<span class="ss-id">' + esc(r.identity) + '</span>')
  bindRowPreview(row, () => previewHtml(r, title))
  return row
}

// ── ⓘ 底部 sheet 预览(触屏的 hover 等价物):状态/来源/目录/最近活跃 + 续接 primary ──
function kvRow(k, vHtml, cls) {
  return '<div class="lg-kvrow"><span class="k">' + esc(k) + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + vHtml + '</span></div>'
}
function openInfoSheet(r) {
  const title = rowTitle(r)
  const sheet = openSheet({ id: 'sessInfoSheet', title, rows: [] })
  const body = sheet.el.querySelector('.lg-sheet-body')
  body.innerHTML =
    kvRow('标识', esc(r.identity || '—')) +
    kvRow('状态', badgeHtml(r.status) || '<span class="lg-dim">已结束</span>') +
    kvRow('来源', esc(r.providerName) + (r.kind === 'term' ? '(终端)' : '(对话)')) +
    kvRow('目录', esc(r.cwd || '—'), 'dir') +
    kvRow('最近活跃', esc(relTime(r.lastActive, Date.now()) || '—')) +
    '<div class="ss-info-acts">' +
    '<button class="lg-btn block" id="ssInfoOpen">' + (r.status === 'recoverable' ? '续接会话' : '进入会话') + '</button>' +
    (r.kind === 'chat' ? '<button class="lg-btn ghost block" id="ssInfoArchive">归档</button>' : '') +
    '</div>'
  body.querySelector('#ssInfoOpen').addEventListener('click', () => { sheet.close(); openRow(r) })
  const arch = body.querySelector('#ssInfoArchive')
  if (arch) arch.addEventListener('click', () => { sheet.close(); archiveChat(r) })
}

// ── 批量模式(行首 check + 底部 dockbar;归档主/删除 danger 隔离) ───────────────
function toggleBatch() {
  _batch.mode = !_batch.mode
  _batch.ids = new Set()
  syncSelectBtn()
  renderList()
  renderBatchBar()
}
function syncSelectBtn() {
  const b = document.getElementById('sessionsSelect'); if (!b) return
  b.textContent = _batch.mode ? '完成' : '选择'
  b.classList.toggle('on', _batch.mode)
}
function togglePick(r, row) {
  if (_batch.ids.has(r.id)) _batch.ids.delete(r.id); else _batch.ids.add(r.id)
  row.classList.toggle('picked', _batch.ids.has(r.id))
  const cb = row.querySelector('.ss-cb'); if (cb) cb.setAttribute('aria-checked', _batch.ids.has(r.id) ? 'true' : 'false')
  renderBatchBar()
}
function exitBatch() {
  _batch.mode = false; _batch.ids = new Set()
  syncSelectBtn(); renderBatchBar()
}
function renderBatchBar() {
  const bar = document.getElementById('sessionsActions'); if (!bar) return
  // 批量模式下主操作在 dockbar,FAB 让位(否则压住右隔离的「删除」)。
  if (_fab) _fab.style.display = _batch.mode ? 'none' : ''
  if (!_batch.mode) { bar.classList.remove('show'); bar.innerHTML = ''; return }
  bar.classList.add('show')
  const n = _batch.ids.size
  const visibleIds = applyFilters().map((r) => r.id)
  const allPicked = n > 0 && visibleIds.length > 0 && visibleIds.every((id) => _batch.ids.has(id))
  bar.innerHTML =
    '<div class="lg-dockbar-row">' +
    '<span class="ss-sel-n">已选 ' + n + '</span>' +
    '<button class="lg-btn ghost" id="ssSelAll">' + (allPicked ? '取消全选' : '全选') + '</button>' +
    '<button class="lg-btn" id="ssBatchArchive">归档</button>' +
    '<button class="lg-btn danger ss-del" id="ssBatchDel">删除</button>' +
    '</div>'
  bar.querySelector('#ssSelAll').addEventListener('click', () => {
    _batch.ids = allPicked ? new Set() : new Set(visibleIds)
    renderList(); renderBatchBar()
  })
  bar.querySelector('#ssBatchArchive').addEventListener('click', doBatchArchive)
  bar.querySelector('#ssBatchDel').addEventListener('click', doBatchDelete)
}
function pickedRows() {
  return Array.from(_batch.ids).map((id) => _rows.find((r) => r.id === id)).filter(Boolean)
}
async function doBatchArchive() {
  const rows = pickedRows()
  if (!rows.length) { toast('未选择任何会话'); return }
  const chats = rows.filter((r) => r.kind === 'chat')
  const skipped = rows.length - chats.length
  if (!chats.length) { toast('所选无可归档对话(终端不支持归档)'); return }
  const ok = await confirmModal('归档 ' + chats.length + ' 个对话?' + (skipped ? '(跳过 ' + skipped + ' 个终端)' : ''), { okText: '归档' })
  if (!ok) return
  let fail = 0
  for (const r of chats) {
    try { await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(r.id) + '/metadata', 'PATCH', { archived: true }) }
    catch (e) { fail++ }
  }
  toast('已归档 ' + (chats.length - fail) + ' 个' + (fail ? ',失败 ' + fail + ' 个' : ''), { type: fail ? 'err' : 'ok' })
  exitBatch(); refresh()
}
async function doBatchDelete() {
  const rows = pickedRows()
  if (!rows.length) { toast('未选择任何会话'); return }
  const ok = await confirmModal('删除选中的 ' + rows.length + ' 个会话?', { body: '删除后不可恢复。', danger: true, okText: '删除' })
  if (!ok) return
  let fail = 0
  for (const r of rows) {
    const path = (r.kind === 'chat' ? '/api/cc/chat/sessions/' : '/api/cc/sessions/') + encodeURIComponent(r.id)
    try { await api(path, { method: 'DELETE' }) } catch (e) { fail++ }
  }
  toast('已删除 ' + (rows.length - fail) + ' 个' + (fail ? ',失败 ' + fail + ' 个' : ''), { type: fail ? 'err' : 'ok' })
  exitBatch(); refresh()
}

// ── 行点击:分族跳转;recoverable 先确认再 resume ──────────────────────────────
function openRow(r) {
  if (r.status === 'recoverable') return resumeRow(r)
  if (r.kind === 'chat') {
    const m = r.meta
    const hint = r.titleWeak ? cachedTitle(r.id) : rowTitle(r)
    router.open('chat', { id: m.id, name: m.name, titleHint: hint, provider: m.provider, effort: m.effort, model: m.model, active_plan: m.active_plan, message_count: m.message_count })
  } else {
    router.open('term', r.meta)
  }
}

// recoverable 行点击即自动续接(§11a 末条):直接 POST /resume → 进终端,无确认弹窗;失败 toast。
async function resumeRow(r) {
  try {
    const meta = await apiJson('/api/cc/sessions/' + encodeURIComponent(r.id) + '/resume', 'POST', {})
    router.open('term', meta)
    refresh()
  } catch (e) { toast('续接失败:' + (e.message || e), { type: 'err' }) }
}

// ── 长按 / 行尾菜单:改名·绑定计划·压缩(chat)·归档/杀死·删除 ──────────────────
function openRowMenu(r, anchor) {
  const items = []
  items.push({ icon: icons.edit, label: '改名', onTap: () => renameRow(r) })
  items.push({ icon: icons.flag, label: '绑定计划', onTap: () => bindPlan(r) })
  if (r.kind === 'chat') items.push({ icon: icons.compress, label: '压缩上下文', onTap: () => compactChat(r) })
  if (r.kind === 'chat') items.push({ icon: icons.archive, label: '归档', onTap: () => archiveChat(r) })
  else items.push({ icon: icons.power, label: '杀死会话', danger: true, onTap: () => killTerm(r) })
  items.push({ icon: icons.trash, label: '删除', danger: true, onTap: () => deleteRow(r) })
  openMenu({ anchor: anchor || _scroll, items })
}

async function renameRow(r) {
  const init = r.kind === 'term' ? (getTermName(r.id) || r.title) : r.title
  const name = await promptModal('会话名', init)
  if (name == null || !name.trim()) return
  const path = r.kind === 'chat' ? '/api/cc/chat/sessions/' + encodeURIComponent(r.id) + '/name' : null
  try {
    if (path) await apiJson(path, 'PATCH', { name: name.trim() })
    else { setTermName(r.id, name.trim()); }   // 终端展示名为本地态
    refresh()
  } catch (e) { toast('改名失败:' + (e.message || e), { type: 'err' }) }
}
function setTermName(id, name) { try { localStorage.setItem('lofa.termName.' + id, name) } catch (e) {} }

async function bindPlan(r) {
  const plan = await promptModal('绑定计划(计划 id)', r.meta && r.meta.active_plan ? r.meta.active_plan : '')
  if (plan == null) return
  const seg = r.kind === 'chat' ? '/api/cc/chat/sessions/' : '/api/cc/sessions/'
  try { await apiJson(seg + encodeURIComponent(r.id) + '/active_plan', 'PATCH', { plan_id: plan.trim() }); refresh() }
  catch (e) { toast('绑定失败:' + (e.message || e), { type: 'err' }) }
}

async function compactChat(r) {
  try { await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(r.id) + '/compact', 'POST', {}); toast('已压缩,生成新会话', { type: 'ok' }); refresh() }
  catch (e) { toast('压缩失败:' + (e.message || e), { type: 'err' }) }
}
async function archiveChat(r) {
  try { await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(r.id) + '/metadata', 'PATCH', { archived: true }); refresh() }
  catch (e) { toast('归档失败:' + (e.message || e), { type: 'err' }) }
}
async function killTerm(r) {
  const ok = await confirmModal('杀死此终端会话?', { danger: true, okText: '杀死' })
  if (!ok) return
  try { await api('/api/cc/sessions/' + encodeURIComponent(r.id), { method: 'DELETE' }); refresh() }
  catch (e) { toast('操作失败:' + (e.message || e), { type: 'err' }) }
}
async function deleteRow(r) {
  const ok = await confirmModal('删除此会话?', { body: '删除后不可恢复。', danger: true, okText: '删除' })
  if (!ok) return
  const path = (r.kind === 'chat' ? '/api/cc/chat/sessions/' : '/api/cc/sessions/') + encodeURIComponent(r.id)
  try { await api(path, { method: 'DELETE' }); refresh() }
  catch (e) { toast('删除失败:' + (e.message || e), { type: 'err' }) }
}

// ── 新建 sheet(零配置直达,§7b) ──────────────────────────────────────────────
function readLastNew() { try { return JSON.parse(localStorage.getItem(LAST_NEW_KEY) || 'null') } catch (e) { return null } }
function writeLastNew(v) { try { localStorage.setItem(LAST_NEW_KEY, JSON.stringify(v)) } catch (e) {} }

// 新建 sheet 全程用自定义 DOM 承载:类型选择是暂存态(不同于 openSheet 的 radio「即选即收起」),
// 「新建」按钮需常驻,故只借 openSheet 的外壳(把手/标题/scrim/层管理/id)。
// §7b 简化:删掉「工作目录」整个分区,cwd 一律固定 FIXED_CWD。
function openNewSheet() {
  const last = readLastNew()
  let typeId = (last && TYPE_BY_ID[last.typeId]) ? last.typeId : NEW_TYPES[0].id

  const sheet = openSheet({ id: 'newSheet', title: '新建会话', rows: [] })
  const body = sheet.el.querySelector('.lg-sheet-body')

  // 「继续上次配置」一击直达(仅记类型)。
  if (last && TYPE_BY_ID[last.typeId]) {
    const t = TYPE_BY_ID[last.typeId]
    const big = document.createElement('button'); big.className = 'lg-sheet-row lg-sheet-big'
    big.innerHTML = '<span class="lg-sheet-l">' + icons.bolt + ' 继续上次配置新建<span class="lg-sheet-sub">' + esc(t.label) + '</span></span>'
    big.addEventListener('click', () => runCreate(big, last.typeId))
    body.appendChild(big)
  }

  // 类型(10 项两组;暂存选择,点选只切高亮不收起)。
  const th = document.createElement('div'); th.className = 'lg-sheet-header'; th.textContent = '类型'; body.appendChild(th)
  const typeWrap = document.createElement('div')
  NEW_TYPES.forEach((t, i) => {
    if (i === 5) { const d = document.createElement('div'); d.className = 'lg-sheet-div'; typeWrap.appendChild(d) }
    const b = document.createElement('button'); b.className = 'lg-sheet-radio' + (t.id === typeId ? ' on' : ''); b.setAttribute('data-type', t.id)
    b.innerHTML = '<span class="lg-sheet-l">' + esc(t.label) + '</span><span class="lg-radio-mark"></span>'
    b.addEventListener('click', () => {
      typeId = t.id
      typeWrap.querySelectorAll('.lg-sheet-radio').forEach((x) => x.classList.toggle('on', x.getAttribute('data-type') === typeId))
    })
    typeWrap.appendChild(b)
  })
  body.appendChild(typeWrap)

  // 主按钮「新建」。
  const go = document.createElement('div'); go.className = 'ss-new-go'
  const btn = document.createElement('button'); btn.className = 'lg-btn block'; btn.id = 'newCreate'; btn.textContent = '新建'
  btn.addEventListener('click', () => runCreate(btn, typeId))
  go.appendChild(btn); body.appendChild(go)

  // 在途态创建:点击后按钮变「新建中…」并禁用;成功 → 关 sheet + 跳转;
  // 失败或 12s 超时 → 恢复按钮 + toast 错误(杜绝「点了没动静」)。
  async function runCreate(triggerBtn, tid) {
    if (triggerBtn.disabled) return
    const orig = triggerBtn.textContent
    triggerBtn.disabled = true; triggerBtn.textContent = '新建中…'
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return; settled = true
      triggerBtn.disabled = false; triggerBtn.textContent = orig
      toast('新建超时,请重试', { type: 'err' })
    }, 12000)
    try {
      const res = await createSession(tid)
      if (settled) return
      settled = true; clearTimeout(timer)
      sheet.close()
      if (res.kind === 'chat') {
        const m = res.meta
        router.open('chat', { id: m.id, name: m.name, provider: m.provider, effort: m.effort, model: m.model, active_plan: m.active_plan })
      } else {
        router.open('term', res.meta)
      }
      refresh()
    } catch (e) {
      if (settled) return
      settled = true; clearTimeout(timer)
      triggerBtn.disabled = false; triggerBtn.textContent = orig
      toast('新建失败:' + (e.message || e), { type: 'err' })
    }
  }
}

// 建会话:POST 对应族接口,cwd 固定 FIXED_CWD;抛错交由 runCreate 的在途态处理。
async function createSession(typeId) {
  const t = TYPE_BY_ID[typeId]; if (!t) throw new Error('未知类型')
  writeLastNew({ typeId })
  if (t.group === 'chat') {
    const meta = await apiJson('/api/cc/chat/sessions', 'POST', { provider: t.provider, cwd: FIXED_CWD })
    return { kind: 'chat', meta }
  }
  const meta = await apiJson('/api/cc/sessions', 'POST', { cmd: t.cmd || null, cwd: FIXED_CWD, cols: 80, rows: 24, safe_mode: false })
  return { kind: 'term', meta }
}
