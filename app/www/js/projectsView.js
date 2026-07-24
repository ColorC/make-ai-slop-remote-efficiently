// projectsView.js — 项目 tab 根页(应用 / 列表 / 任务 / 计划 四段)与只读详情推入页。
// 契约导出:init() / load()(见 §9);openDetail(board,id) 供内部行点击调用,兼容
// app.js 已接线的单参 opener(project-detail 深链本轮未启用,但引用需可调用)。
// 纯只读:全程只发 GET,不加任何写操作。渲染层薄,列表/状态/筛选逻辑全部来自 projectsState.js。
//
// 四段(§11e 项目双视图 + 追加修订):
//   应用 = 真启动器:/api/project-views 的 apps 置顶(点击 app 内全屏网页),其后接全部项目
//          图标宫格(pinned 在前,其余按分组顺序;点击进项目详情)。
//   列表 = 取代旧卡片板:按分组渲染(可折叠分组头,折叠态记 localStorage),行=展示图 + 名 +
//          简介 + 活跃相对时间 + 快速入口按钮(项目 links)。点行主体进项目详情。
//   任务 / 计划 = 沿用旧行为(含筛选 pill,状态筛选只在这两段显示)。
// 打开网页经 router.open('web', {url,title})(app.js 注册到 notesView.openWeb),不直接 import 视图。

import { esc, api, LOG, store } from './core.js'
import { largeHeader, listRow, emptyState, segmented, openSheet, icons } from './ui.js'
import * as router from './router.js'
import {
  statusFilters, statusMeta, shortTime,
  listPath, planDetailPath, projectPlansPath, extractItems,
  projectFilterOptions, normalizeCards, filterByStatus,
} from './projectsState.js'

// 四段:应用 / 列表 / 任务 / 计划。列表/任务/计划映射到后端工作板 projects/quests/plans。
const SEGMENTS = [
  { value: 'apps', label: '应用' },
  { value: 'list', label: '列表' },
  { value: 'quests', label: '任务' },
  { value: 'plans', label: '计划' },
]
const SEG_LABEL = { apps: '应用', list: '项目', quests: '任务', plans: '计划' }
const SEG_TO_BOARD = { list: 'projects', quests: 'quests', plans: 'plans' }
const DEFAULT_SEG = 'list'
const SEG_KEY = 'lofa.projectsSeg'
const COLLAPSE_KEY = 'lofa.projGroupsCollapsed'

const BOARD_LABEL = { projects: '项目', quests: '任务', plans: '计划' }

const ICON_QUEST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/></svg>'
const ICON_PLAN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 13h6M9 17h6"/></svg>'
const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v6h-6"/></svg>'
const ICON_FILTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>'
const ICON_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'
const BOARD_ICON = { quests: ICON_QUEST, plans: ICON_PLAN }

// ── 只读护栏:项目 tab 只消费 GET 端点(进度真源是 whatnow,手机端不写状态) ────
function apiGet(path) { return api(path, { method: 'GET' }) }

// ── 模块状态 ────────────────────────────────────────────────────────────────
let curSeg = DEFAULT_SEG
let curStatus = ''
let curProject = ''          // 计划板的项目筛选(空=全部)
let projectsData = null      // 缓存 /api/projects, 供列表分组 / 计划板项目筛选 / 启动器项目宫格复用
let cardsById = {}           // 当前列表卡片(供详情复用, 免重复拉取)
let pendingFresh = false     // 顶栏刷新置位一次: 下一次列表加载穿透服务端 index 缓存(?fresh=1)

function readSeg() {
  try { const v = localStorage.getItem(SEG_KEY); if (SEGMENTS.some((s) => s.value === v)) return v } catch (e) {}
  return DEFAULT_SEG
}
function writeSeg(v) { try { localStorage.setItem(SEG_KEY, v) } catch (e) {} }
function readCollapsed() { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {} } catch (e) { return {} } }
function writeCollapsed(m) { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(m)) } catch (e) {} }

export function init() {
  const v = document.getElementById('projectsView'); v.innerHTML = ''
  curSeg = readSeg()
  const head = largeHeader({ title: '项目', actions: [{ icon: ICON_REFRESH, label: '刷新', onTap: refresh }] })
  // 段(应用/列表/任务/计划)+ 「筛选」pill(§11c:pill 只在任务/计划段显示,开 sheet 选状态 / 计划板项目)。
  const board = document.createElement('div'); board.className = 'proj-board'
  const seg = document.createElement('div'); seg.id = 'projectsBoardSeg'
  const pill = document.createElement('button'); pill.className = 'proj-filter-pill'; pill.id = 'projectsFilterPill'
  pill.addEventListener('click', openFilterSheet)
  board.appendChild(seg); board.appendChild(pill)
  // 头部(大标题 + 段 + 筛选)随内容一起滚动:全部放进滚动容器顶部,列表另起内层 host(§6 反馈 1)。
  const scroll = document.createElement('div'); scroll.className = 'scroll'
  const list = document.createElement('div'); list.className = 'lg-list'; list.id = 'projectsList'
  scroll.appendChild(head.el); scroll.appendChild(board); scroll.appendChild(list)
  v.appendChild(scroll)

  segmented(seg, {
    options: SEGMENTS.map((s) => ({ value: s.value, label: s.label })),
    value: curSeg,
    onChange: (val) => { curSeg = val; writeSeg(val); curStatus = ''; curProject = ''; updateFilterPill(); run() },
  })
  updateFilterPill()
}

export function load() {
  updateFilterPill()
  run()
}

// ── 刷新(头部图标钮):清前端项目缓存 + 下一次列表加载穿透服务端 index 缓存 ──
function refresh() {
  projectsData = null
  pendingFresh = true
  updateFilterPill()
  run()
}

function run() {
  if (curSeg === 'apps') return runApps()
  return runList()
}

// ──「筛选」pill:只在任务/计划段显示;角标=生效筛选数(状态 + 计划板项目) ─────────
function updateFilterPill() {
  const pill = document.getElementById('projectsFilterPill'); if (!pill) return
  const showPill = curSeg === 'quests' || curSeg === 'plans'
  pill.style.display = showPill ? '' : 'none'
  if (!showPill) { pill.classList.remove('on'); pill.innerHTML = ''; return }
  const n = (curStatus ? 1 : 0) + (curSeg === 'plans' && curProject ? 1 : 0)
  pill.innerHTML = '<span class="proj-filter-ic">' + ICON_FILTER + '</span><span>筛选</span>' +
    (n ? '<span class="proj-filter-badge">' + n + '</span>' : '')
  pill.classList.toggle('on', n > 0)
}

// 筛选 sheet:状态单选(按段对应板)+ 计划段追加项目单选 + 清除。即改即生效不收起。
function sheetHeader(text) { const d = document.createElement('div'); d.className = 'lg-sheet-header'; d.textContent = text; return d }
function radioBtn(label, on) {
  const b = document.createElement('button'); b.className = 'lg-sheet-radio' + (on ? ' on' : '')
  b.innerHTML = '<span class="lg-sheet-l">' + esc(label) + '</span><span class="lg-radio-mark"></span>'
  return b
}
function openFilterSheet() {
  if (curSeg !== 'quests' && curSeg !== 'plans') return
  const board = SEG_TO_BOARD[curSeg]
  const sheet = openSheet({ id: 'projectsFilterSheet', title: '筛选', rows: [] })
  const body = sheet.el.querySelector('.lg-sheet-body')

  body.appendChild(sheetHeader('状态'))
  const stWrap = document.createElement('div')
  const renderStatus = () => {
    stWrap.innerHTML = ''
    statusFilters(board).forEach(([val, label]) => {
      const b = radioBtn(label, val === curStatus); b.setAttribute('data-status', val)
      b.addEventListener('click', () => { curStatus = val; renderStatus(); updateFilterPill(); run() })
      stWrap.appendChild(b)
    })
  }
  renderStatus(); body.appendChild(stWrap)

  if (curSeg === 'plans') {
    body.appendChild(sheetHeader('项目'))
    const pjWrap = document.createElement('div')
    const renderProj = () => {
      pjWrap.innerHTML = ''
      projectFilterOptions(projectsData).forEach((o) => {
        const b = radioBtn(o.name, o.id === curProject); b.setAttribute('data-project', o.id)
        b.addEventListener('click', () => { curProject = o.id; renderProj(); updateFilterPill(); run() })
        pjWrap.appendChild(b)
      })
    }
    renderProj(); body.appendChild(pjWrap)
    if (!projectsData) ensureProjectsData().then(renderProj)   // 项目清单未就绪则拉后补渲染
  }

  const go = document.createElement('div'); go.className = 'proj-filter-clear'
  const clr = document.createElement('button'); clr.className = 'lg-btn ghost block'; clr.id = 'projectsFilterClear'; clr.textContent = '清除筛选'
  clr.addEventListener('click', () => { curStatus = ''; curProject = ''; updateFilterPill(); sheet.close(); run() })
  go.appendChild(clr); body.appendChild(go)
}

// ── 通用:打开网页(经 router opener,避免 view 之间 import) ────────────────────
function openWebUrl(url, title) { router.open('web', { url, title: title || '' }) }

// ── 展示图 / 图标块:资产图 → 背景图;渐变/色值 → 色块 + 首字;无 → 识别色块 + 首字 ──
// 相对路径(/api/project-assets/…)拼 store.base;绝对地址原样。
function assetUrl(u) {
  u = String(u == null ? '' : u).trim()
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  return (store.base || '').replace(/\/+$/, '') + (u.charAt(0) === '/' ? u : '/' + u)
}
function firstChar(s) { const a = Array.from(String(s == null ? '' : s).trim()); return a.length ? a[0] : '·' }
function hashHue(s) { let h = 0; const str = String(s == null ? '' : s); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h }
function thumbEl(p, cls) {
  const el = document.createElement('span'); el.className = cls
  const bg = String((p && p.bg) || '').trim()
  const name = (p && (p.name || p.id)) || ''
  if (/^\//.test(bg)) {                              // 相对资产图 → 拼 store.base 作背景图
    el.style.backgroundImage = 'url("' + (store.base || '').replace(/\/+$/, '') + bg + '")'
    el.classList.add('img')
  } else if (/^(linear-gradient|radial-gradient|#|rgb|hsl)/i.test(bg)) {  // 渐变/色值 → 色块 + 首字
    el.style.background = bg
    el.textContent = firstChar(name)
  } else {                                           // 无 → 识别色块 + 首字
    el.style.background = 'hsl(' + hashHue((p && p.id) || name) + ',40%,32%)'
    el.textContent = firstChar(name)
  }
  return el
}

// ── 相对时间短标(活跃情况;项目 last_active) ─────────────────────────────────
function relTime(iso) {
  if (!iso) return '—'
  const t = Date.parse(iso); if (isNaN(t)) return '—'
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60); if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60); if (h < 24) return h + ' 小时前'
  const d = Math.floor(h / 24); if (d < 30) return d + ' 天前'
  const mo = Math.floor(d / 30); if (mo < 12) return mo + ' 个月前'
  return Math.floor(mo / 12) + ' 年前'
}

// ── 列表加载态 / 错误卡 ───────────────────────────────────────────────────────
function loadingRow(label) {
  const d = document.createElement('div'); d.className = 'proj-loading'
  d.innerHTML = '<span class="lg-spin"></span><span>' + esc(label) + '</span>'
  return d
}
function renderError(box, title, msg, retryFn) {
  box.innerHTML = ''
  box.appendChild(emptyState({ icon: icons.info, title, hint: msg, action: { label: '重试', onTap: retryFn } }))
}

// 缓存 /api/projects,并把项目卡片并入 cardsById(供任意段的项目详情复用)。
function setProjectsData(data) {
  if (!data) return
  projectsData = data
  normalizeCards('projects', extractItems('projects', data)).forEach((c) => { cardsById[c.id] = c })
}
async function ensureProjectsData() {
  if (projectsData) return projectsData
  try { const d = await apiGet('/api/projects'); setProjectsData(d) } catch (e) { projectsData = null }
  return projectsData
}

// ════ 应用段(真启动器):apps 置顶 + 全部项目图标宫格 ════
function appCell(a) {
  const b = document.createElement('button'); b.className = 'proj-app'
  const ic = document.createElement('span'); ic.className = 'proj-app-icon'
  const iconUrl = (a && a.icon_url) ? assetUrl(a.icon_url) : ''
  if (iconUrl) { ic.classList.add('img'); ic.style.backgroundImage = 'url("' + iconUrl + '")' }  // 有 icon_url → 圆角方形图标
  else if (a && a.icon) { ic.classList.add('emoji'); ic.textContent = a.icon }                       // 数据自带字符图标
  else { ic.innerHTML = icons.box }                                                                  // 无则回退线条图标
  const nm = document.createElement('span'); nm.className = 'proj-app-name'; nm.textContent = (a && (a.label || a.id)) || ''
  b.appendChild(ic); b.appendChild(nm)
  b.addEventListener('click', () => openWebUrl(a.url, a.label || a.id))
  return b
}
function projectCell(p) {
  const b = document.createElement('button'); b.className = 'proj-app'
  b.appendChild(thumbEl(p, 'proj-app-icon'))
  const nm = document.createElement('span'); nm.className = 'proj-app-name'; nm.textContent = p.name || p.id || ''
  b.appendChild(nm)
  b.addEventListener('click', () => openDetail('projects', p.id))
  return b
}
// 项目排序:pinned 在前,其余按 groups_order,组内保持原序(sort 稳定)。
function orderedProjects(data) {
  const projs = extractItems('projects', data)
  const order = (data && data.groups_order) || []
  const gi = (g) => { const i = order.indexOf(g); return i < 0 ? order.length : i }
  return projs.slice().sort((a, b) => {
    const pa = a.pinned ? 0 : 1, pb = b.pinned ? 0 : 1
    if (pa !== pb) return pa - pb
    return gi(a.group) - gi(b.group)
  })
}
function secLabel(text) { const d = document.createElement('div'); d.className = 'proj-launch-sec'; d.textContent = text; return d }

async function runApps() {
  const box = document.getElementById('projectsList'); if (!box) return
  box.innerHTML = ''; box.appendChild(loadingRow('加载应用…'))
  pendingFresh = false
  const [viewsRes, projRes] = await Promise.all([
    apiGet('/api/project-views').catch((e) => { LOG.rec('error', ['project-views', e.message || e]); return null }),
    ensureProjectsData().catch(() => null),
  ])
  const apps = (viewsRes && viewsRes.apps) || []
  const projData = projRes || projectsData
  const projs = orderedProjects(projData)
  box.innerHTML = ''
  const wrap = document.createElement('div'); wrap.id = 'projectsApps'; wrap.className = 'proj-launcher'
  box.appendChild(wrap)
  if (!apps.length && !projs.length) { box.appendChild(emptyState({ icon: icons.info, title: '暂无应用' })); return }
  if (apps.length) {
    wrap.appendChild(secLabel('应用'))
    const g = document.createElement('div'); g.className = 'proj-apps'
    apps.forEach((a) => g.appendChild(appCell(a))); wrap.appendChild(g)
  }
  if (projs.length) {
    wrap.appendChild(secLabel('项目'))
    const g = document.createElement('div'); g.className = 'proj-apps'
    projs.forEach((p) => g.appendChild(projectCell(p))); wrap.appendChild(g)
  }
}

// ════ 列表段(按分组渲染 + 可折叠分组头) ════
function groupProjects(data) {
  const projs = extractItems('projects', data)
  const order = (data && data.groups_order) || []
  const labels = (data && data.group_labels) || {}
  const byGroup = {}
  projs.forEach((p) => { const g = p.group || ''; (byGroup[g] = byGroup[g] || []).push(p) })
  const groups = []
  order.forEach((g) => { if (byGroup[g]) { groups.push({ id: g, label: labels[g] || g, items: byGroup[g] }); delete byGroup[g] } })
  Object.keys(byGroup).forEach((g) => groups.push({ id: g || 'ungrouped', label: labels[g] || g || '其它', items: byGroup[g] }))
  return groups
}
function projectListRow(p) {
  const wrap = document.createElement('div'); wrap.className = 'proj-item'
  const main = document.createElement('button'); main.className = 'proj-item-main'
  main.appendChild(thumbEl(p, 'proj-thumb'))
  const body = document.createElement('div'); body.className = 'proj-item-body'
  const name = document.createElement('div'); name.className = 'proj-item-name'; name.textContent = p.name || p.id || ''
  body.appendChild(name)
  const descText = p.short || p.desc || ''
  if (descText) { const d = document.createElement('div'); d.className = 'proj-item-desc'; d.textContent = descText; body.appendChild(d) }
  const time = document.createElement('div'); time.className = 'proj-item-time'; time.textContent = '活跃 ' + relTime(p.last_active)
  body.appendChild(time)
  main.appendChild(body)
  main.addEventListener('click', () => openDetail('projects', p.id))
  wrap.appendChild(main)
  const links = Array.isArray(p.links) ? p.links.filter((l) => l && l.url) : []
  if (links.length) {
    const bar = document.createElement('div'); bar.className = 'proj-links'
    links.forEach((l) => {
      const btn = document.createElement('button'); btn.className = 'proj-link'; btn.textContent = l.label || l.url
      btn.addEventListener('click', (e) => { e.stopPropagation(); openWebUrl(l.url, l.label || '') })
      bar.appendChild(btn)
    })
    wrap.appendChild(bar)
  }
  return wrap
}
function renderProjectList(box, data) {
  box.innerHTML = ''
  const projs = extractItems('projects', data)
  if (!projs.length) { box.appendChild(emptyState({ icon: icons.info, title: '暂无项目' })); return }
  const groups = groupProjects(data)
  const flat = groups.length <= 1 && (!groups[0] || groups[0].id === 'ungrouped')
  if (flat) { (groups[0] ? groups[0].items : projs).forEach((p) => box.appendChild(projectListRow(p))); return }
  const collapsed = readCollapsed()
  groups.forEach((g) => {
    const isCol = !!collapsed[g.id]
    const head = document.createElement('button'); head.className = 'proj-group-head' + (isCol ? ' collapsed' : ''); head.setAttribute('data-group', g.id)
    head.innerHTML = '<span class="proj-group-chev">' + ICON_CHEV + '</span><span class="proj-group-label">' + esc(g.label) +
      '</span><span class="proj-group-count">' + g.items.length + '</span>'
    const gbody = document.createElement('div'); gbody.className = 'proj-group-body'; if (isCol) gbody.style.display = 'none'
    g.items.forEach((p) => gbody.appendChild(projectListRow(p)))
    head.addEventListener('click', () => {
      const nowCol = !head.classList.contains('collapsed')
      head.classList.toggle('collapsed', nowCol)
      gbody.style.display = nowCol ? 'none' : ''
      const m = readCollapsed(); if (nowCol) m[g.id] = 1; else delete m[g.id]; writeCollapsed(m)
    })
    box.appendChild(head); box.appendChild(gbody)
  })
}

// ── 列表加载(列表/任务/计划) ─────────────────────────────────────────────────
async function runList() {
  const box = document.getElementById('projectsList'); if (!box) return
  const board = SEG_TO_BOARD[curSeg]
  box.innerHTML = ''; box.appendChild(loadingRow('加载' + (SEG_LABEL[curSeg] || '') + '…'))
  const fresh = pendingFresh; pendingFresh = false
  try {
    if (curSeg === 'plans' && !projectsData) { await ensureProjectsData(); updateFilterPill() }
    const data = await apiGet(listPath(board, { project: curProject, fresh }))
    if (board === 'projects') setProjectsData(data)
    if (curSeg === 'list') { renderProjectList(box, data); return }
    let cards = normalizeCards(board, extractItems(board, data))
    cards = filterByStatus(cards, curStatus)
    cards.forEach((c) => { cardsById[c.id] = c })
    renderRows(box, cards)
  } catch (e) {
    renderError(box, '加载失败', e.message || String(e), runList)
    LOG.rec('error', ['projects.list', curSeg, curProject, e.message || e])
  }
}

function emptyMsg() {
  if (curSeg === 'plans' && curProject) return '该项目下暂无计划'
  if (curStatus) return '该筛选下暂无' + (SEG_LABEL[curSeg] || '内容')
  return '暂无' + (SEG_LABEL[curSeg] || '内容')
}
function renderRows(box, cards) {
  box.innerHTML = ''
  if (!cards.length) { box.appendChild(emptyState({ icon: icons.info, title: emptyMsg() })); return }
  cards.forEach((c) => box.appendChild(cardRow(c)))
}

// ── 状态 → 行圆点/徽标配色(只用已有 token 变体: ok/busy/bad/muted/accent) ───
function dotFor(status) {
  const M = { active: 'ok', main: 'ok', stale: 'busy', archived: 'busy', blocked: 'bad', side: 'hollow', done: 'hollow', parked: 'hollow' }
  return M[status] || 'hollow'
}
function badgeVariant(status) {
  const M = { active: 'ok', main: 'accent', stale: 'busy', archived: 'busy', blocked: 'bad', side: 'muted', done: 'muted', parked: 'muted' }
  return M[status] || 'muted'
}
function badgeHtml(status) {
  const m = statusMeta(status)
  return m.label ? '<span class="proj-badge ' + badgeVariant(m.key) + '">' + esc(m.label) + '</span>' : ''
}
function plainBadgeHtml(text) {
  return text ? '<span class="proj-badge muted">' + esc(text) + '</span>' : ''
}

// ── 列表行(任务/计划;项目段走 renderProjectList) ────────────────────────────
function cardRow(c) {
  if (c.board === 'quests') return questRow(c)
  return planRow(c)
}
function questRow(c) {
  const sub = [c.chapter || c.objective || '', c.activePlanCount + ' 进行中计划'].filter(Boolean).join(' · ')
  return listRow({
    icon: BOARD_ICON.quests, statusDot: dotFor(c.status),
    title: c.title, sub,
    metaRight: esc(statusMeta(c.status).label),
    onTap: () => openDetail('quests', c.id),
  })
}
function planRow(c) {
  const sub = [c.category, c.date].filter(Boolean).join(' · ')
  return listRow({
    icon: BOARD_ICON.plans, statusDot: dotFor(c.status),
    title: c.title, sub,
    metaRight: esc(statusMeta(c.status).label),
    onTap: () => openDetail('plans', c.id),
  })
}

// ── 只读详情推入页(项目/任务/计划三形态) ─────────────────────────────────────
// 入参兼容两种调用:内部行点击 openDetail(board,id);单参形式给 app.js 已接线的
// project-detail opener(本轮深链未启用,但引用需保持可调用),接受 "board:id" 或裸 id(默认 projects)。
export function openDetail(a, b) {
  let board, id
  if (b !== undefined) { board = a; id = b }
  else if (typeof a === 'string' && a.indexOf(':') > 0) { const i = a.indexOf(':'); board = a.slice(0, i); id = a.slice(i + 1) }
  else { board = 'projects'; id = a }

  renderDetailShell(board)
  router.push('projectDetailView')
  if (board === 'quests') renderQuestDetail(cardsById[id], id)
  else if (board === 'plans') renderPlanDetail(id)
  else renderProjectDetail(id, cardsById[id])
}

function renderDetailShell(board) {
  const v = document.getElementById('projectDetailView')
  v.innerHTML =
    '<div class="lg-nav"><button class="lg-nav-back" aria-label="返回">' + icons.back + '</button>' +
    '<div class="lg-nav-mid"><div class="lg-nav-title">' + esc(BOARD_LABEL[board] || '详情') + '</div></div>' +
    '<div class="lg-nav-actions"></div></div>' +
    '<div class="scroll"><div class="proj-detail-body" id="projectDetail"></div></div>'
  v.querySelector('.lg-nav-back').addEventListener('click', () => router.pop())
}
function setDetailTitle(t) {
  const el = document.querySelector('#projectDetailView .lg-nav-title')
  if (el && t) el.textContent = t
}
function sectionHtml(title, bodyHtml) {
  return '<div class="proj-section"><div class="proj-section-title">' + esc(title) + '</div>' + bodyHtml + '</div>'
}
function threadBadgesHtml(threads) {
  return '<div class="proj-badges">' + threads.map((t) => {
    const m = statusMeta(t.status)
    return '<span class="proj-badge ' + badgeVariant(m.key) + '">' + esc(t.name || '(线)') + (t.stale ? icons.warn : '') + '</span>'
  }).join('') + '</div>'
}

// 项目详情:工作线(已在列表卡片里)+ 关联计划(需求求 /projects/{id}/plans)
async function renderProjectDetail(id, card) {
  const box = document.getElementById('projectDetail'); if (!box) return
  const title = card ? card.title : id
  setDetailTitle(title)
  box.innerHTML =
    '<h1 class="proj-detail-title">' + (card && card.pinned ? icons.pin + ' ' : '') + esc(title) + '</h1>' +
    '<div class="proj-badges">' +
    (card ? badgeHtml(card.status) : '') + (card ? plainBadgeHtml(card.group) : '') +
    (card ? plainBadgeHtml('活跃 ' + (shortTime(card.lastActive) || '—')) : '') +
    '</div>' +
    (card && card.stale && card.staleReason ? '<div class="proj-warn">' + icons.warn + ' ' + esc(card.staleReason) + '</div>' : '') +
    (card && card.threads && card.threads.length ? sectionHtml('工作线', threadBadgesHtml(card.threads)) : '') +
    '<div class="proj-section"><div class="proj-section-title">关联计划</div><div class="proj-sub-list" id="projDetailPlans"></div></div>'
  const plansHost = box.querySelector('#projDetailPlans')
  plansHost.appendChild(loadingRow('加载关联计划…'))
  try {
    const data = await apiGet(projectPlansPath(id))
    const cards = normalizeCards('plans', data.items || [])
    cards.forEach((c) => { cardsById[c.id] = c })
    plansHost.innerHTML = ''
    if (!cards.length) { plansHost.appendChild(emptyState({ icon: icons.info, title: '该项目下暂无计划' })); return }
    cards.forEach((c) => plansHost.appendChild(planRow(c)))
  } catch (e) {
    plansHost.innerHTML = ''
    plansHost.appendChild(emptyState({
      icon: icons.info, title: '关联计划加载失败', hint: e.message,
      action: { label: '重试', onTap: () => renderProjectDetail(id, card) },
    }))
    LOG.rec('error', ['projects.detail.plans', id, e.message || e])
  }
}

// 任务详情:长期目标/当前章节/进行中子目标(数据已随列表卡片拿到, 无单独端点)
function renderQuestDetail(card, id) {
  const box = document.getElementById('projectDetail'); if (!box) return
  if (!card) { box.innerHTML = ''; box.appendChild(emptyState({ icon: icons.info, title: '任务不存在', hint: id })); return }
  setDetailTitle(card.title)
  const subsHtml = (card.sub || []).map((s) =>
    '<div class="proj-subitem"><div class="proj-subitem-title">' + esc(s.title || s.id) + '</div>' +
    (s.date ? '<div class="proj-subitem-meta">' + esc(s.date) + '</div>' : '') + '</div>',
  ).join('')
  box.innerHTML =
    '<h1 class="proj-detail-title">' + esc(card.title) + '</h1>' +
    '<div class="proj-badges">' + badgeHtml(card.status) + plainBadgeHtml(card.group) +
    plainBadgeHtml(card.activePlanCount + ' 进行中计划') +
    plainBadgeHtml('活跃 ' + (shortTime(card.lastActive) || '—')) + '</div>' +
    (card.objective ? sectionHtml('长期目标', '<p class="proj-text">' + esc(card.objective) + '</p>') : '') +
    (card.chapter ? sectionHtml('当前章节', '<p class="proj-text">' + esc(card.chapter) + '</p>') : '') +
    sectionHtml('进行中计划', subsHtml || '<div class="proj-empty-inline">暂无进行中计划</div>')
}

// 计划详情:元数据 + 文档摘要(需单独拉取 /api/plans/{id})
async function renderPlanDetail(id) {
  const box = document.getElementById('projectDetail'); if (!box) return
  box.innerHTML = ''; box.appendChild(loadingRow('加载计划…'))
  try {
    const p = await apiGet(planDetailPath(id))
    const meta = (p && p.meta) || {}
    const archived = !!(p && p.archived)
    const title = p.date && p.topic ? p.date + ' ' + p.topic : (p.topic || id)
    setDetailTitle(title)
    const docs = ((p && p.files) || []).filter((f) => f.is_md)
    const docsHtml = docs.map((f) =>
      '<div class="proj-subitem"><div class="proj-subitem-title">' + esc(f.path) + '</div>' +
      (f.summary ? '<div class="proj-subitem-meta">' + esc(f.summary) + '</div>' : '') + '</div>',
    ).join('')
    box.innerHTML =
      '<h1 class="proj-detail-title">' + esc(title) + '</h1>' +
      '<div class="proj-badges">' + badgeHtml(archived ? 'archived' : (meta.status || 'active')) +
      plainBadgeHtml(meta.work_type ? String(meta.work_type) : '') + '</div>' +
      sectionHtml('文档', docsHtml || '<div class="proj-empty-inline">该计划暂无文档</div>')
  } catch (e) {
    box.innerHTML = ''
    box.appendChild(emptyState({
      icon: icons.info, title: '加载失败', hint: e.message,
      action: { label: '重试', onTap: () => renderPlanDetail(id) },
    }))
    LOG.rec('error', ['plans.detail', id, e.message || e])
  }
}
