// reviewView.js — 审阅收件箱(tab 根,小标题+搜索+seg 筛选+图例+时间桶列表+多选批量)与
// 详情推入页(kv 元数据条 + 米色文档卡 + 三态裁决组盖章 + TOC 弹层)。契约导出:init() / load() / openDetail(id)(见 §9)。
//
// 纯逻辑(筛选常量/路径/多选 reducer/批量 payload/角标映射/坐标归一/行号定位/
// 模板兜底/WS 事件判别)全部复用 reviewState.js,本模块只碰 DOM 与 API。
// V2 蓝图精制波二(2026-07-19):队列行 div→button、副行默认收起(ⓘ sheet/hover 预览)、
// 「新」改 lg-newtag 标注框、tier 点 10px+lg-legend 图例;批量条改 lg-verdict 结构;
// 详情 kv 条(lg-kv)+rv-d-doc 米色卡满铺+lg-stamp 盖章+「目录」弹层。

import {
  esc, toast, api, apiJson, mdToHtml, store, LOG, confirmModal, promptModal,
} from './core.js'
import { emptyState, icons, openMenu, segmented, openSheet, bindRowPreview, bpRuler } from './ui.js'
import * as router from './router.js'
import { openReconnectingWs } from './ws.js'
import * as S from './reviewState.js'

// ── 本模块图标(kind 分形 + 刷新;通用图标复用 ui.icons) ───────────────────────
const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>'
const ICON_DOC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/></svg>'
const ICON_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
const ICON_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3"/></svg>'
const ICON_QUESTION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7"/><path d="M12 17h.01"/></svg>'
const KIND_ICONS = {
  markdown: ICON_DOC,
  image: ICON_IMAGE,
  'aigc-image': ICON_IMAGE,
  video: ICON_VIDEO,
  html: icons.link,
  custom_web_template: icons.link,
  'static-report': icons.link,
  demo: icons.link,
  key_question: ICON_QUESTION,
}
const KIND_LABELS = {
  markdown: '报告',
  image: '图片',
  'aigc-image': '候选图',
  video: '视频',
  html: '网页',
  custom_web_template: '网页',
  'static-report': '网页',
  demo: '网页',
  key_question: '问题',
}
const TIER_LABELS = { mandatory: '强制', important: '重要', processual: '流程' }
const STATUS_LABELS = { pending: '待审', accepted: '通过', rejected: '驳回', blocked: '搁置' }
// 展示文案统一用「搁置」指代 blocked verdict(与详情操作条措辞一致);API 值仍是 reviewState 的 'blocked'。
const VERDICT_LABELS = { accepted: '通过', rejected: '驳回', blocked: '搁置' }
const kindIcon = (k) => KIND_ICONS[k] || icons.info
const kindLabel = (k) => KIND_LABELS[k] || k || ''
const tierLabel = (t) => TIER_LABELS[t] || t || ''
const statusLabel = (s) => STATUS_LABELS[s] || s || ''
const verdictLabel = (v) => VERDICT_LABELS[v] || v
const verdictDoneLabel = (v) => '已' + verdictLabel(v)
function planTail(p) {
  if (!p) return ''
  const parts = String(p).split('/')
  return parts[parts.length - 1] || String(p)
}
// 分段(§11c):待审 / 已处理(accepted+rejected+blocked)/ 全部。
// 待审=服务端 status=pending;已处理/全部=服务端拉全量,已处理再客户端收敛到已处理集。
const SEGMENTS = [['pending', '待审'], ['processed', '已处理'], ['all', '全部']]
const PROCESSED_SET = ['accepted', 'rejected', 'blocked']
const TIER_OPTS = [['', '全部层级'], ['mandatory', '强制'], ['important', '重要'], ['processual', '流程']]
const FILTER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>'
function relTime(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime(); if (!isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 0) return String(iso).replace('T', ' ').slice(0, 16)
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  if (diff < 86400000 * 30) return Math.floor(diff / 86400000) + ' 天前'
  return String(iso).replace('T', ' ').slice(0, 10)
}
// 时间桶分组(今天/昨天/本周/更早),桶内按时间倒序。
const BUCKET_ORDER = ['今天', '昨天', '本周', '更早']
function bucketOf(iso, now) {
  const t = iso ? new Date(iso).getTime() : NaN
  if (!isFinite(t)) return '更早'
  const dayMs = 86400000
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
  const diffDays = Math.floor((startOfDay(now) - startOfDay(t)) / dayMs)
  if (diffDays <= 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays <= 7) return '本周'
  return '更早'
}
function sortDesc(items) {
  return items.slice().sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
}
function groupItems(items) {
  const now = Date.now()
  const buckets = {}
  items.forEach((m) => { const k = bucketOf(m.updated_at || m.created_at, now); (buckets[k] = buckets[k] || []).push(m) })
  return BUCKET_ORDER.filter((k) => buckets[k] && buckets[k].length).map((k) => ({ label: k, items: buckets[k] }))
}

// ── 模块状态 ────────────────────────────────────────────────────────────────
let curSeg = 'pending'
let curTier = ''
let includeArchived = false
let searchQuery = ''
let sel = S.SELECTION_INIT
let lastItems = []
let statsCache = null
let curMaterial = null
let conn = null
let _refreshTimer = null
let annotateMode = false
let selectBtnEl = null
let immersive = false
let detailGeneration = 0
let detailAbort = null
let _segCtl = null
let _tocHeads = []
const ICON_IMMERSIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>'

// ── tab 根:紧凑两行头部(随内容滚动) + 列表 + 底部批量操作条 ─────────────────
// §11c/反馈 2 瘦身:去大标题占位。第一行「审阅」小标题(17px 左)+ 右侧图标区
//   (搜索图标点击原地展开整行输入框 / 「选择」/ 刷新);第二行 segmented 与「筛选」pill 同排;
//   第三行 tier 图例(强制 N/重要 N,真实计数)。整个头部放进滚动容器顶部,随列表一起滚走(反馈 1)。
export function init() {
  const v = document.getElementById('reviewView'); v.innerHTML = ''
  router.onChange(({ view }) => { if (view !== 'reviewDetailView') exitImmersive() })
  document.addEventListener('fullscreenchange', () => {
    const detail = document.getElementById('reviewDetailView')
    if (immersive && document.fullscreenElement !== detail) setImmersive(false, true)
  })
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') exitImmersive() })
  sel = S.SELECTION_INIT
  const scroll = document.createElement('div'); scroll.className = 'scroll'
  const head = document.createElement('div'); head.className = 'rv-head'; head.id = 'reviewHead'
  head.innerHTML =
    '<div class="rv-head-top">' +
    '<div class="rv-head-title">审阅<span class="rv-head-badge" style="display:none"></span></div>' +
    '<div class="rv-head-acts">' +
    '<button class="lg-icon-btn" id="reviewSearchBtn" aria-label="搜索">' + icons.search + '</button>' +
    '<button class="lg-icon-btn rv-head-text" id="reviewSelect" aria-label="选择">选择</button>' +
    '<button class="lg-icon-btn" id="reviewRefresh" aria-label="刷新">' + ICON_REFRESH + '</button>' +
    '</div></div>' +
    '<div class="rv-search"><span class="rv-search-ic">' + icons.search + '</span>' +
    '<input type="search" id="reviewSearch" placeholder="搜索标题" autocapitalize="off" autocorrect="off" spellcheck="false"></div>' +
    '<div class="rv-filterbar" id="reviewFilters"><div id="reviewSeg"></div>' +
    '<button class="rv-filter-pill" id="reviewFilterPill"></button></div>' +
    '<div class="lg-legend rv-legend" id="reviewLegend"></div>'
  head.appendChild(bpRuler())  // 页头 chrome 底部横向刻度尺(aria-hidden;与 largeHeader 同一实现)
  const list = document.createElement('div'); list.className = 'lg-list'; list.id = 'reviewList'
  scroll.appendChild(head); scroll.appendChild(list)
  const actions = document.createElement('div'); actions.className = 'rv-actions'; actions.id = 'reviewActions'
  v.appendChild(scroll); v.appendChild(actions)

  selectBtnEl = head.querySelector('#reviewSelect')
  selectBtnEl.addEventListener('click', () => toggleSelectMode())
  head.querySelector('#reviewRefresh').addEventListener('click', () => loadList())
  head.querySelector('#reviewFilterPill').addEventListener('click', openFilterSheet)
  // 搜索图标:点击原地展开整行输入框,再点收起(收起时清空过滤)。
  const searchBtn = head.querySelector('#reviewSearchBtn')
  const searchInput = head.querySelector('#reviewSearch')
  searchBtn.addEventListener('click', () => {
    const on = !head.classList.contains('searching')
    head.classList.toggle('searching', on)
    searchBtn.classList.toggle('on', on)
    if (on) { try { searchInput.focus() } catch (e) {} }
    else { searchInput.value = ''; if (searchQuery) { searchQuery = ''; renderList() } }
  })
  searchInput.addEventListener('input', () => { searchQuery = searchInput.value || ''; renderList() })

  _segCtl = segmented(head.querySelector('#reviewSeg'), { options: segOpts(), value: curSeg, onChange: (val) => { curSeg = val; loadList() } })
  updateFilterPill()
  // 「目录」弹层外部点击收起(详情页共用一次绑定)。
  document.addEventListener('click', (e) => {
    const pop = document.getElementById('rvTocPop')
    if (!pop || !pop.classList.contains('open')) return
    if (e.target.closest('#rvTocPop') || e.target.closest('#reviewToc')) return
    pop.classList.remove('open')
  })
}
export function load() { loadList() }

// seg 选项:待审计数来自 _stats(真实数据),已处理/全部无服务端合计不计数。
function segOpts() {
  const by = (statsCache && statsCache.by_status) || {}
  const pend = (typeof by.pending === 'number') ? by.pending : (parseInt(by.pending, 10) || null)
  return SEGMENTS.map(([value, label]) => ({ value, label, count: value === 'pending' ? pend : null }))
}

// 未读推送角标(pushed_unread):设在「审阅」小标题旁。
function setReviewBadge(n) {
  const b = document.querySelector('#reviewHead .rv-head-badge'); if (!b) return
  if (n) { b.textContent = String(n); b.style.display = '' } else { b.style.display = 'none' }
}

// 分段 → 服务端 status 参数(已处理/全部都拉全量,已处理在客户端收敛)。
function segStatus() { return curSeg === 'pending' ? 'pending' : '' }

function toggleSelectMode() {
  sel = S.selectionReducer(sel, { type: sel.mode ? 'exit' : 'enter' })
  syncSelectBtn()
  renderList()
}
function syncSelectBtn() {
  if (!selectBtnEl) return
  selectBtnEl.innerHTML = sel.mode ? '取消' : '选择'
  selectBtnEl.setAttribute('aria-label', sel.mode ? '取消选择' : '选择')
}

// ──「筛选」pill 角标(生效的次级筛选数:层级 + 含已归档) ────────────────────
function updateFilterPill() {
  const pill = document.getElementById('reviewFilterPill'); if (!pill) return
  const n = (curTier ? 1 : 0) + (includeArchived ? 1 : 0)
  pill.innerHTML = '<span class="rv-filter-ic">' + FILTER_ICON + '</span><span>筛选</span>' +
    (n ? '<span class="rv-filter-badge">' + n + '</span>' : '')
  pill.classList.toggle('on', n > 0)
}

// 筛选 sheet:层级单选(全部/强制/重要/流程)+ 含已归档 toggle + 清除。即改即生效不收起。
function openFilterSheet() {
  const sheet = openSheet({ id: 'reviewFilterSheet', title: '筛选', rows: [] })
  const body = sheet.el.querySelector('.lg-sheet-body')

  const th = document.createElement('div'); th.className = 'lg-sheet-header'; th.textContent = '材料层级'; body.appendChild(th)
  const tierWrap = document.createElement('div')
  const renderTiers = () => {
    tierWrap.innerHTML = ''
    TIER_OPTS.forEach(([val, label]) => {
      const b = document.createElement('button'); b.className = 'lg-sheet-radio' + (val === curTier ? ' on' : ''); b.setAttribute('data-tier', val)
      b.innerHTML = '<span class="lg-sheet-l">' + esc(label) + '</span><span class="lg-radio-mark"></span>'
      b.addEventListener('click', () => { curTier = val; renderTiers(); updateFilterPill(); loadList() })
      tierWrap.appendChild(b)
    })
  }
  renderTiers(); body.appendChild(tierWrap)

  const div = document.createElement('div'); div.className = 'lg-sheet-div'; body.appendChild(div)
  const arch = document.createElement('button'); arch.className = 'lg-sheet-row'; arch.id = 'reviewArchToggle'
  const renderArch = () => { arch.innerHTML = '<span class="lg-sheet-l">含已归档</span><span class="lg-switch' + (includeArchived ? ' on' : '') + '"></span>' }
  renderArch(); arch.addEventListener('click', () => { includeArchived = !includeArchived; renderArch(); updateFilterPill(); loadList() })
  body.appendChild(arch)

  const go = document.createElement('div'); go.className = 'rv-filter-clear'
  const clr = document.createElement('button'); clr.className = 'lg-btn ghost block'; clr.id = 'reviewFilterClear'; clr.textContent = '清除筛选'
  clr.addEventListener('click', () => { curTier = ''; includeArchived = false; updateFilterPill(); sheet.close(); loadList() })
  go.appendChild(clr); body.appendChild(go)
}

// ── 列表加载 + 渲染(时间桶分组) ──────────────────────────────────────────────
async function loadList() {
  ensureWs()
  const box = document.getElementById('reviewList'); if (!box) return
  box.innerHTML = '<div class="rv-loading">加载中…</div>'
  try {
    const [data, stats] = await Promise.all([
      api(S.listPath({ status: segStatus(), tier: curTier, include_archived: includeArchived })),
      api(S.statsPath()).catch(() => null),
    ])
    lastItems = (data && data.items) || []
    if (stats) {
      statsCache = stats
      setReviewBadge(S.statsBadges(stats).find((b) => b.key === 'pushed_unread').count)
      if (_segCtl) _segCtl.setOptions(segOpts())
    }
    updateFilterPill()
    renderList()
  } catch (e) {
    box.innerHTML = '<div class="rv-error">加载失败: ' + esc(e.message) + '</div>'
    LOG.rec('error', ['review.list.fail', e.message])
  }
}
// 客户端筛选:已处理分段收敛到 accepted/rejected/blocked;再叠加标题搜索。
function applyClientFilter(items) {
  let out = items || []
  if (curSeg === 'processed') out = out.filter((m) => PROCESSED_SET.indexOf(String(m.status || '').toLowerCase()) >= 0)
  const q = searchQuery.trim().toLowerCase()
  if (q) out = out.filter((m) => String(m.title || '').toLowerCase().indexOf(q) >= 0)
  return out
}
function renderList() {
  const box = document.getElementById('reviewList'); if (!box) return
  const filtered = applyClientFilter(lastItems)
  renderLegend(filtered)
  if (!filtered.length) {
    box.innerHTML = ''
    box.appendChild(emptyState({ icon: icons.info, title: '暂无材料', hint: searchQuery ? '换个关键词试试' : '该筛选下暂无材料' }))
    renderSelectBar(); return
  }
  const groups = groupItems(sortDesc(filtered))
  box.innerHTML = ''
  groups.forEach((g) => {
    const h = document.createElement('div'); h.className = 'lg-sec-head'
    h.innerHTML = esc(g.label) + '<span class="lg-count rv-sec-n">' + g.items.length + '</span>'
    box.appendChild(h)
    g.items.forEach((m) => box.appendChild(rowEl(m)))
  })
  renderSelectBar()
}
// tier 图例:强制 N/重要 N(当前筛选下真实计数)。
function renderLegend(items) {
  const el = document.getElementById('reviewLegend'); if (!el) return
  let mandatory = 0, important = 0
  ;(items || []).forEach((m) => {
    const t = String(m.tier || '').toLowerCase()
    if (t === 'mandatory') mandatory++; else if (t === 'important') important++
  })
  el.innerHTML =
    '<span class="lg-i"><i class="led" style="background:var(--bad)"></i>强制 ' + mandatory + '</span>' +
    '<span class="lg-i"><i class="led" style="background:var(--busy)"></i>重要 ' + important + '</span>'
}
function tierBadgeCls(t) {
  t = String(t || '').toLowerCase()
  return t === 'mandatory' ? 'st-err' : (t === 'important' ? 'st-warn' : 'st-idle')
}
function rowEl(m) {
  const fl = S.cardFlags(m)
  const picked = S.selHas(sel, m.id)
  const row = document.createElement('button')
  row.className = 'lg-row rv-row' + (picked ? ' picked' : '')
  row.setAttribute('data-id', String(m.id))
  row.innerHTML =
    (sel.mode
      ? '<span class="lg-check rv-cb' + (picked ? ' on' : '') + '" aria-checked="' + (picked ? 'true' : 'false') + '"><span class="cb">' + icons.check + '</span></span>'
      : '') +
    '<span class="rv-tier-dot rv-tier-' + esc(m.tier || '') + '" aria-hidden="true"></span>' +
    '<span class="lg-row-icon">' + kindIcon(m.kind) + '</span>' +
    '<span class="lg-row-body">' +
    '<span class="lg-row-title">' + esc(m.title || '(无标题)') + '</span>' +
    // 副行(plan/时间)留 DOM 默认 CSS 收起(少字);完整信息进 ⓘ sheet / hover 预览。
    '<span class="lg-row-sub">' + [kindLabel(m.kind), planTail(m.source_plan_id), relTime(m.updated_at || m.created_at)].filter(Boolean).map(esc).join(' · ') + '</span>' +
    '</span>' +
    '<span class="lg-row-side">' +
    (fl.pushedUnread ? '<span class="lg-newtag">新</span>' : '') +
    '</span>' +
    '<span class="lr-info" role="button" aria-label="预览">' + icons.info + '</span>'
  row.addEventListener('click', (e) => {
    if (e.target.closest('.lr-info')) return openRowSheet(m)
    if (sel.mode) toggleSelect(m.id); else openDetail(m.id)
  })
  bindRowPreview(row, () => rowPreviewHtml(m))
  return row
}
// hover 预览卡(hover 设备;触屏等价 = ⓘ sheet,内容同源)。
function rowPreviewHtml(m) {
  return '<div class="pv-t"><span class="lg-badge ' + tierBadgeCls(m.tier) + '"><i class="led"></i>' + esc(tierLabel(m.tier)) + '</span>' +
    (S.cardFlags(m).pushedUnread ? '<span class="lg-newtag">新</span>' : '') + '</div>' +
    '<div class="pv-d strong">' + esc(m.title || '(无标题)') + '</div>' +
    '<div class="pv-meta"><span>' + esc(kindLabel(m.kind)) + '</span><span>' + esc(planTail(m.source_plan_id) || '—') + '</span>' +
    '<span>' + esc(relTime(m.updated_at || m.created_at)) + '</span></div>'
}
// ⓘ 底部 sheet 预览:层级/类型/计划/更新/状态 + 打开 primary。
function kvRow(k, vHtml, cls) {
  return '<div class="lg-kvrow"><span class="k">' + esc(k) + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + vHtml + '</span></div>'
}
function openRowSheet(m) {
  const sheet = openSheet({ id: 'rvRowSheet', title: m.title || '(无标题)', rows: [] })
  const body = sheet.el.querySelector('.lg-sheet-body')
  body.innerHTML =
    kvRow('层级', '<span class="lg-badge ' + tierBadgeCls(m.tier) + '"><i class="led"></i>' + esc(tierLabel(m.tier)) + '</span>') +
    kvRow('类型', esc(kindLabel(m.kind))) +
    kvRow('计划', esc(planTail(m.source_plan_id) || '—'), 'dir') +
    kvRow('更新', esc(relTime(m.updated_at || m.created_at))) +
    kvRow('状态', esc(statusLabel(m.status))) +
    '<div class="rv-info-acts"><button class="lg-btn block" id="rvRowOpen">打开材料</button></div>'
  body.querySelector('#rvRowOpen').addEventListener('click', () => { sheet.close(); openDetail(m.id) })
}

// ── 多选:切换 → 只同步勾选态 DOM,不整表重渲染 ──────────────────────────────
function toggleSelect(id) {
  sel = S.selectionReducer(sel, { type: 'toggle', id })
  syncSelectionDom()
}
function syncSelectionDom() {
  const box = document.getElementById('reviewList'); if (!box) return
  Array.prototype.forEach.call(box.querySelectorAll('.rv-row'), (el) => {
    const id = el.getAttribute('data-id')
    const picked = S.selHas(sel, id)
    el.classList.toggle('picked', picked)
    const cb = el.querySelector('.rv-cb')
    if (cb) { cb.classList.toggle('on', picked); cb.setAttribute('aria-checked', picked ? 'true' : 'false') }
  })
  renderSelectBar()
}
// 批量动作条:lg-verdict 结构(通过/驳回/搁置成组 + 全选 ghost + 删除 danger 右隔离)。
function renderSelectBar() {
  const bar = document.getElementById('reviewActions'); if (!bar) return
  if (!sel.mode) { bar.classList.remove('show'); bar.innerHTML = ''; return }
  bar.classList.add('show')
  const n = S.selCount(sel)
  const visibleIds = applyClientFilter(lastItems).map((m) => m.id)
  const allPicked = n > 0 && n >= visibleIds.length
  const verdictBtns = S.VERDICTS.map((v) =>
    '<button class="vd-i" data-v="' + v.value + '"><i class="led"></i>' + esc(verdictLabel(v.value)) + '</button>').join('')
  bar.innerHTML =
    '<div class="rv-actions-row lg-verdict">' +
    '<span class="rv-actions-count">已选 ' + n + '</span>' +
    '<div class="vd-group">' + verdictBtns + '</div>' +
    '<button class="lg-btn ghost" id="rvSelAll">' + (allPicked ? '取消全选' : '全选') + '</button>' +
    '<button class="lg-btn danger rv-del" id="rvSelDel">删除</button>' +
    '</div>'
  bar.querySelector('#rvSelAll').addEventListener('click', () => {
    sel = allPicked ? S.selectionReducer(sel, { type: 'clear' }) : S.selectionReducer(sel, { type: 'selectAll', ids: visibleIds })
    syncSelectionDom()
  })
  Array.prototype.forEach.call(bar.querySelectorAll('[data-v]'), (b) => {
    b.addEventListener('click', () => doBatchVerdict(b.getAttribute('data-v')))
  })
  bar.querySelector('#rvSelDel').addEventListener('click', () => doBatchDelete())
}

// ── 批量动作 ──────────────────────────────────────────────────────────────────
async function doBatchVerdict(v) {
  const ids = S.selIds(sel)
  if (!ids.length) { toast('未选择任何材料'); return }
  const label = verdictLabel(v)
  const ok = await confirmModal('批量' + label + ' ' + ids.length + ' 项?', { okText: label, danger: v !== 'accepted' })
  if (!ok) return
  try {
    const resp = await apiJson(S.batchVerdictPath(), 'POST', S.buildBatchVerdictPayload(ids, v))
    reportBatch(resp, ids, '批量' + label)
    LOG.rec('info', ['review.batch.verdict', v, ids.length])
    sel = S.selectionReducer(sel, { type: 'exit' })
    await loadList()
  } catch (e) { toast('批量操作失败: ' + e.message); LOG.rec('error', ['review.batch.verdict.fail', v, e.message]) }
}
async function doBatchDelete() {
  const ids = S.selIds(sel)
  if (!ids.length) { toast('未选择任何材料'); return }
  const ok = await confirmModal('删除选中的 ' + ids.length + ' 项?此操作不可撤销。', { okText: '删除', danger: true })
  if (!ok) return
  try {
    const resp = await apiJson(S.batchDeletePath(), 'POST', S.buildBatchDeletePayload(ids))
    reportBatch(resp, ids, '批量删除')
    LOG.rec('info', ['review.batch.delete', ids.length])
    sel = S.selectionReducer(sel, { type: 'exit' })
    await loadList()
  } catch (e) { toast('批量删除失败: ' + e.message); LOG.rec('error', ['review.batch.delete.fail', e.message]) }
}
function reportBatch(resp, ids, label) {
  const sum = S.summarizeBatch(resp, ids)
  const parts = [sum.ok + ' 项已处理']
  if (sum.failed.length) parts.push(sum.failed.length + ' 失败')
  if (sum.skippedPending) parts.push(sum.skippedPending + ' 项待审已跳过(需含待审)')
  toast(label + ': ' + parts.join(', '))
}

// ── 详情推入页 ────────────────────────────────────────────────────────────────
export async function openDetail(id) {
  ensureWs()
  const gen = ++detailGeneration
  if (detailAbort) { try { detailAbort.abort() } catch (e) {} }
  const ctrl = new AbortController(); detailAbort = ctrl
  buildDetailShell()
  router.push('reviewDetailView')
  const body = document.getElementById('reviewDetailBody')
  if (body) body.innerHTML = '<div class="rv-loading">加载中…</div>'
  try {
    const m = await api(S.detailPath(id), { signal: ctrl.signal })
    if (gen !== detailGeneration || ctrl.signal.aborted) return
    curMaterial = m
    renderDetail(m)
  } catch (e) {
    if (gen !== detailGeneration || ctrl.signal.aborted) return
    if (body) body.innerHTML = '<div class="rv-error">加载失败: ' + esc(e.message) + '</div>'
    LOG.rec('error', ['review.detail.fail', id, e.message])
  } finally {
    if (detailAbort === ctrl) detailAbort = null
  }
}
function buildDetailShell() {
  exitImmersive()
  const v = document.getElementById('reviewDetailView'); if (!v) return
  v.classList.remove('rv-immersive', 'rv-content-first', 'rv-web-detail', 'rv-markdown-detail')
  v.innerHTML =
    '<div class="lg-nav">' +
    '<button class="lg-nav-back" aria-label="Back">' + icons.back + '</button>' +
    '<div class="lg-nav-mid"><div class="lg-nav-title" id="reviewDetailTitle"></div></div>' +
    '<div class="lg-nav-actions">' +
    '<button class="lg-icon-btn" id="reviewToc" aria-label="Contents" style="display:none">' + icons.list + '</button>' +
    '<button class="lg-icon-btn" id="reviewImmersive" aria-label="Fullscreen">' + ICON_IMMERSIVE + '</button>' +
    '<button class="lg-icon-btn" id="reviewDetailMore" aria-label="More">' + icons.dots + '</button></div>' +
    '</div>' +
    '<div class="scroll rv-detail-scroll" id="reviewDetailScroll"><div class="rv-d-main" id="reviewDetailBody"></div></div>' +
    '<div class="rv-detail-bar" id="reviewDetailBar"></div>'
  v.querySelector('.lg-nav-back').addEventListener('click', () => router.pop())
  v.querySelector('#reviewToc').addEventListener('click', (e) => { e.stopPropagation(); toggleTocPop() })
  v.querySelector('#reviewImmersive').addEventListener('click', () => setImmersive(!immersive))
  v.querySelector('#reviewDetailMore').addEventListener('click', (e) => openDetailMenu(e.currentTarget))
}

function setImmersive(on, skipFullscreenApi) {
  immersive = !!on
  const v = document.getElementById('reviewDetailView'); if (!v) return
  v.classList.toggle('rv-immersive', immersive)
  document.body.classList.toggle('review-immersive-active', immersive)
  const btn = v.querySelector('#reviewImmersive'); if (btn) btn.classList.toggle('on', immersive)
  closeTocPop()
  if (skipFullscreenApi) return
  if (immersive) {
    if (!document.fullscreenElement && v.requestFullscreen) {
      try { const p = v.requestFullscreen(); if (p && p.catch) p.catch(() => {}) } catch (e) {}
    }
  } else if (document.fullscreenElement && document.exitFullscreen) {
    try { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}) } catch (e) {}
  }
}

export function exitImmersive() {
  if (!immersive && !document.body.classList.contains('review-immersive-active')) return false
  setImmersive(false)
  return true
}

function renderDetail(m) {
  const titleEl = document.getElementById('reviewDetailTitle'); if (titleEl) titleEl.textContent = m.title || '(无标题)'
  const body = document.getElementById('reviewDetailBody'); if (!body) return
  const view = document.getElementById('reviewDetailView')
  const web = S.isWebMaterial(m)
  const markdown = S.normalizeMaterialKind(m.kind) === 'markdown'
  const contentFirst = web || markdown
  if (view) {
    view.classList.toggle('rv-content-first', contentFirst)
    view.classList.toggle('rv-web-detail', web)
    view.classList.toggle('rv-markdown-detail', markdown)
  }
  // G 米卡整列满铺:rv-d-head(标题 + kv 元数据条,蓝图区,邮票格/章互斥承载 tier·状态)
  //   + rv-d-doc(正文全在米色文档卡,min-height 100% 满铺到底)。frontmatter 不泄漏(渲染前剥)。
  body.innerHTML =
    '<div class="rv-d-head" id="rvDHead">' +
    stampOrPostage(m) +
    '<div class="rv-title">' + esc(m.title || '(无标题)') + '</div>' +
    '<div class="rv-kvs">' +
    '<span class="lg-kv"><span class="k">TYPE</span><span class="v">' + esc(kindLabel(m.kind)) + '</span></span>' +
    '<span class="lg-kv"><span class="k">TIER</span><span class="v">' + esc(tierLabel(m.tier)) + '</span></span>' +
    '<span class="lg-kv"><span class="k">PLAN</span><span class="v">' + esc(planTail(m.source_plan_id) || '—') + '</span></span>' +
    '<span class="lg-kv"><span class="k">STATUS</span><span class="v">' + esc(statusLabel(m.status)) + '</span></span>' +
    '</div></div>' +
    '<div class="rv-d-doc">' +
    '<div class="rv-detail-content" id="rvContent"></div>' +
    '<div class="rv-detail-comments" id="rvComments"></div>' +
    '</div>'
  Promise.resolve(renderContent(document.getElementById('rvContent'), m)).then(setupToc)
  renderComments(document.getElementById('rvComments'), m)
  renderDetailBar(m.id)
  // 网页/Markdown 默认把内容铺满;右上角悬浮手柄可随时召回标题和裁决操作。
  setImmersive(false)
}
// 邮票格(待审/搁置)与裁决章(通过/驳回)互斥承载 tier·状态(非纯装饰)。
function postageHtml(m) {
  return '<span class="lg-postage">' + esc(tierLabel(m.tier)) + ' · ' + esc(statusLabel(m.status)) + '</span>'
}
function stampHtml(v, noAnim) {
  const accepted = v === 'accepted'
  return '<div class="lg-stamp ' + (accepted ? '' : 'rejected ') + 'show' + (noAnim ? ' no-anim' : '') + '" data-stamp role="img" aria-label="' +
    (accepted ? '已通过' : '已驳回') + '"><span>' + (accepted ? '通过' : '驳回') +
    '<small>' + (accepted ? 'ACCEPTED' : 'REJECTED') + '</small></span></div>'
}
function stampOrPostage(m) {
  const s = String(m.status || '').toLowerCase()
  if (s === 'accepted' || s === 'rejected') return stampHtml(s, true)
  return postageHtml(m)
}
// 裁决成功后盖章:accepted=朱红圆章落下常驻 / rejected=蓝灰方章;搁置不盖章(回邮票格);改判替换。
function stampVerdict(v) {
  const head = document.getElementById('rvDHead'); if (!head) return
  Array.prototype.forEach.call(head.querySelectorAll('[data-stamp], .lg-postage'), (s) => s.remove())
  if (v === 'accepted' || v === 'rejected') head.insertAdjacentHTML('afterbegin', stampHtml(v, false))
  else if (curMaterial) head.insertAdjacentHTML('afterbegin', postageHtml(curMaterial))
}
// 底栏三态裁决组 lg-verdict:通过·搁置成组 / 驳回拉开 / 评论拆出 ghost;选中回显 echo。
function renderDetailBar(id) {
  const bar = document.getElementById('reviewDetailBar'); if (!bar) return
  bar.innerHTML =
    '<div class="lg-verdict rv-verdict" role="radiogroup" aria-label="审阅裁决">' +
    '<div class="vd-group">' +
    '<button class="vd-i" role="radio" data-v="accepted" aria-checked="false"><i class="led"></i>通过</button>' +
    '<button class="vd-i" role="radio" data-v="blocked" aria-checked="false"><i class="led"></i>搁置</button>' +
    '</div>' +
    '<button class="vd-reject" role="radio" data-v="rejected" aria-checked="false">驳回</button>' +
    '<button class="vd-comment" id="rvComment">评论</button>' +
    '</div>' +
    '<div class="vd-echo" aria-live="polite"></div>'
  Array.prototype.forEach.call(bar.querySelectorAll('[data-v]'), (b) => {
    b.addEventListener('click', () => doVerdict(id, b.getAttribute('data-v')))
  })
  bar.querySelector('#rvComment').addEventListener('click', () => addComment(id, null))
  syncVerdictEcho()
}
// 选中回显:当前状态预勾 + echo 文字(aria-live)。
function syncVerdictEcho() {
  const bar = document.getElementById('reviewDetailBar'); if (!bar) return
  const cur = curMaterial ? String(curMaterial.status || '').toLowerCase() : ''
  Array.prototype.forEach.call(bar.querySelectorAll('[data-v]'), (b) => {
    b.setAttribute('aria-checked', b.getAttribute('data-v') === cur ? 'true' : 'false')
  })
  const echo = bar.querySelector('.vd-echo'); if (!echo) return
  if (cur === 'accepted' || cur === 'rejected' || cur === 'blocked') {
    const color = cur === 'accepted' ? 'var(--ok)' : (cur === 'rejected' ? 'var(--bad)' : 'var(--fg-3)')
    echo.innerHTML = '当前裁决:<b style="color:' + color + '">' + esc(verdictDoneLabel(cur)) + '</b>'
  } else echo.textContent = ''
}

// ── 「目录」弹层:章节从正文 h2/h3 提取(无章节藏钮);牛皮纸目录卡(vellum)。 ──
function setupToc() {
  const btn = document.getElementById('reviewToc'); if (!btn) return
  const c = document.getElementById('rvContent')
  _tocHeads = c ? Array.prototype.slice.call(c.querySelectorAll('h2, h3')) : []
  btn.style.display = _tocHeads.length ? '' : 'none'
  closeTocPop()
}
function closeTocPop() {
  const pop = document.getElementById('rvTocPop'); if (pop) pop.classList.remove('open')
}
function toggleTocPop() {
  if (!_tocHeads.length) return
  const v = document.getElementById('reviewDetailView'); if (!v) return
  let pop = document.getElementById('rvTocPop')
  if (!pop) {
    pop = document.createElement('div'); pop.className = 'lg-tocpop'; pop.id = 'rvTocPop'
    v.appendChild(pop)
  } else if (pop.classList.contains('open')) { pop.classList.remove('open'); return }
  pop.innerHTML = '<div class="toc-h">目录</div><div class="lg-toc">' +
    _tocHeads.map((h, i) => {
      if (!h.id) h.id = 'rv-toc-' + i
      return '<button class="toc-i" data-h="' + esc(h.id) + '"><span class="n">' + String(i + 1).padStart(2, '0') + '</span><span>' + esc(h.textContent.trim()) + '</span></button>'
    }).join('') + '</div>'
  Array.prototype.forEach.call(pop.querySelectorAll('.toc-i'), (b) => {
    b.addEventListener('click', () => {
      const t = document.getElementById(b.getAttribute('data-h'))
      pop.querySelectorAll('.toc-i').forEach((x) => x.classList.toggle('on', x === b))
      closeTocPop()
      if (t) { setImmersive(false); try { t.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch (e) {} }
    })
  })
  pop.classList.add('open')
}
function openDetailMenu(anchor) {
  const m = curMaterial; if (!m) return
  const archived = S.cardFlags(m).archived
  openMenu({
    anchor,
    items: [
      ...(S.isWebMaterial(m) ? [
        { label: '通过', onTap: () => doVerdict(m.id, 'accepted') },
        { label: '搁置', onTap: () => doVerdict(m.id, 'blocked') },
        { label: '驳回', danger: true, onTap: () => doVerdict(m.id, 'rejected') },
        { label: '评论', onTap: () => addComment(m.id, null) },
        { label: '在浏览器打开', onTap: () => openWebExternal(m) },
      ] : []),
      { label: archived ? '取消归档' : '归档', onTap: () => doArchive(m.id, !archived) },
      { label: '复制链接', onTap: () => doCopyLink(m) },
    ],
  })
}
async function doArchive(id, archived) {
  try {
    await apiJson(S.archivePath(id), 'POST', S.buildArchivePayload(archived))
    toast(archived ? '已归档' : '已取消归档')
    if (curMaterial && String(curMaterial.id) === String(id)) curMaterial.archived = archived
    LOG.rec('info', ['review.archive', id, archived])
  } catch (e) { toast('操作失败: ' + e.message); LOG.rec('error', ['review.archive.fail', id, e.message]) }
}
function openWebExternal(m) {
  const url = S.resolveWebUrl(m, store.base)
  try { window.open(url, '_blank', 'noopener,noreferrer') } catch (e) {}
}

async function doCopyLink(m) {
  const url = S.resolveWebUrl(m, store.base)
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(url)
    toast('链接已复制')
  } catch (e) { toast(url) }
}

// ── 内容渲染:按 kind 分形(markdown/image/video/key_question/web) ───────────
function renderContent(c, m) {
  if (!c) return
  try {
    if (S.isImageKind(m.kind)) return renderImage(c, m)
    if (S.isVideoKind(m.kind)) {
      c.className = 'rv-video'
      c.innerHTML = '<video controls src="' + store.base + S.filePath(m.id) + '"></video>'
      return
    }
    if (S.isKeyQuestionKind(m.kind)) return renderKeyQuestion(c, m)
    if (S.isWebMaterial(m)) return renderWeb(c, m)
    return renderMarkdown(c, m)
  } catch (e) {
    c.className = ''
    c.innerHTML = '<pre class="rv-error">内容加载失败: ' + esc(e.message) + '</pre>'
  }
}
// key_question: inline_content 是 JSON, 解析成 问题+选项+说明; 解析失败退原始文本。
async function renderKeyQuestion(c, m) {
  let text = m.inline_content
  if (text == null) { try { text = await api(S.filePath(m.id)) } catch (e) { text = '' } }
  const kq = S.parseKeyQuestion(text)
  c.className = 'rv-kq'
  if (!kq.ok) { c.innerHTML = '<pre class="rv-kq-raw">' + esc(kq.raw || '(无内容)') + '</pre>'; return }
  const opts = kq.options.map((opt, i) =>
    '<div class="rv-kq-opt"><span class="rv-kq-key">' + String.fromCharCode(65 + i) + '.</span>' + esc(opt) + '</div>'
  ).join('')
  c.innerHTML =
    '<div class="rv-kq-h">关键问题</div>' +
    '<div class="rv-kq-q">' + esc(kq.question || '(无问题)') + '</div>' +
    (opts ? '<div class="rv-kq-opts">' + opts + '</div>' : '') +
    (kq.explanation ? '<details class="rv-kq-exp"><summary>说明</summary><div class="rv-kq-exp-b">' + esc(kq.explanation) + '</div></details>' : '')
}
// 图片 + 批注覆盖层(归一化坐标 → 百分比定位)。
function renderImage(c, m) {
  c.className = 'rv-img'
  const url = store.base + S.filePath(m.id)
  const annos = S.imageAnnotations(m)
  const pts = annos.map((a, i) => {
    const an = a.anchor
    if (an.type === 'rect') {
      return '<div class="rv-anno-rect" data-i="' + i + '" title="' + esc(a.text) + '" ' +
        'style="left:' + (an.x * 100) + '%;top:' + (an.y * 100) + '%;width:' + (an.w * 100) + '%;height:' + (an.h * 100) + '%"></div>'
    }
    return '<div class="rv-anno-pt" data-i="' + i + '" title="' + esc(a.text) + '" ' +
      'style="left:' + (an.x * 100) + '%;top:' + (an.y * 100) + '%">' + (i + 1) + '</div>'
  }).join('')
  c.innerHTML =
    '<div class="rv-imgwrap"><img src="' + url + '" alt="">' +
    '<div class="rv-anno-layer">' + pts + '</div></div>' +
    '<div class="rv-anno-bar">' +
    '<button class="lg-btn ghost" id="rvAnnoToggle">在图上批注</button>' +
    '<span class="rv-anno-hint" id="rvAnnoHint">' + (annos.length ? (annos.length + ' 处批注') : '暂无批注') + '</span>' +
    '</div>' +
    (annos.length ? '<ol class="rv-anno-list">' + annos.map((a, i) =>
      '<li><b>' + (i + 1) + '</b> ' + esc(a.text || '(无说明)') + (a.by ? ' <i>— ' + esc(a.by) + '</i>' : '') + '</li>').join('') + '</ol>' : '')
  const wrap = c.querySelector('.rv-imgwrap')
  const toggleBtn = c.querySelector('#rvAnnoToggle')
  const hint = c.querySelector('#rvAnnoHint')
  toggleBtn.addEventListener('click', () => {
    annotateMode = !annotateMode
    toggleBtn.classList.toggle('on', annotateMode)
    hint.textContent = annotateMode ? '点击图片选位置…' : (annos.length ? (annos.length + ' 处批注') : '暂无批注')
    wrap.classList.toggle('picking', annotateMode)
  })
  wrap.addEventListener('click', (e) => {
    if (!annotateMode) return
    const r = wrap.getBoundingClientRect()
    const x = S.clamp01((e.clientX - r.left) / (r.width || 1))
    const y = S.clamp01((e.clientY - r.top) / (r.height || 1))
    annotateMode = false; wrap.classList.remove('picking')
    addComment(m.id, { type: 'point', x, y })
  })
}
// markdown: 有行批注 → 行号定位视图(高亮 + 滚动到首个批注行); 否则普通 md 渲染。
// frontmatter 不泄漏原文:普通路径剥首部 --- ... --- 块与正文自带 h1(与详情头重复);
// 行号定位视图不动原文——批注锚的是原始行号。
function stripFrontmatter(text) {
  let t = String(text || '')
  t = t.replace(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  t = t.replace(/^\s*#\s+[^\n]*(\r?\n)?/, '')
  return t
}
async function renderMarkdown(c, m) {
  let text = m.inline_content
  if (text == null) { try { text = await api(S.filePath(m.id)) } catch (e) { text = '' } }
  // 兼容旧/未知 kind:完整 HTML 文档必须由 iframe 装载,不能经 Markdown 转义后显示源码。
  if (S.looksLikeHtmlDoc(text)) return renderWeb(c, m)
  const lineAnnos = S.markdownAnnotations(m)
  if (!lineAnnos.length) { c.className = 'rv-md'; c.innerHTML = mdToHtml(stripFrontmatter(text)); return }
  c.className = 'rv-mdlines'
  const rows = S.buildMarkdownLines(text, lineAnnos)
  c.innerHTML = rows.map((r) =>
    '<div class="rv-mdline' + (r.annotated ? ' anno' : '') + '" data-line="' + r.n + '">' +
    '<span class="ln">' + r.n + '</span>' +
    '<span class="tx">' + (esc(r.text) || '&nbsp;') + '</span>' +
    (r.annotated ? '<div class="rv-mdnote">' + r.notes.map((a) =>
      esc(a.text || '(无说明)') + (a.by ? ' <i>— ' + esc(a.by) + '</i>' : '')).join('<br>') + '</div>' : '') +
    '</div>').join('')
  const first = S.firstAnnotatedLine(text, lineAnnos)
  if (first) {
    const el = c.querySelector('.rv-mdline[data-line="' + first + '"]')
    if (el && el.scrollIntoView) setTimeout(() => { try { el.scrollIntoView({ block: 'center' }) } catch (e) {} }, 20)
  }
}
// 网页材料: html / live_url → iframe; custom_web_template → iframe + 通用兜底卡。
function renderWeb(c, m) {
  const view = document.getElementById('reviewDetailView')
  if (view) {
    view.classList.add('rv-content-first', 'rv-web-detail')
    view.classList.remove('rv-markdown-detail')
  }
  c.className = 'rv-web'
  const url = S.resolveWebUrl(m, store.base)
  c.innerHTML = '<iframe referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"></iframe>'
  const frame = c.querySelector('iframe')
  if (S.looksLikeHtmlDoc(m.inline_content)) frame.srcdoc = String(m.inline_content)
  else frame.src = url
}
// 评论(无锚点的普通评论)
function renderComments(box, m) {
  if (!box) return
  const cmts = S.plainComments(m)
  if (!cmts.length) { box.innerHTML = ''; return }
  box.innerHTML = '<div class="rv-comments-h">评论 ' + cmts.length + '</div>' +
    cmts.map((a) => '<div class="rv-comment"><div class="rv-comment-by">' + esc(a.by || '匿名') +
      (a.at ? ' · ' + esc(String(a.at).replace('T', ' ').slice(0, 16)) : '') + '</div>' +
      '<div class="rv-comment-tx">' + esc(a.text || '') + '</div></div>').join('')
}
async function addComment(id, anchor) {
  const text = await promptModal(anchor ? '批注说明' : '写评论', '', { textarea: true, okText: '提交' })
  if (text == null || !String(text).trim()) return
  try {
    await apiJson(S.commentPath(id), 'POST', S.buildCommentPayload(text, anchor ? { anchor } : {}))
    toast(anchor ? '批注已提交' : '评论已提交')
    LOG.rec('info', ['review.comment', id, anchor ? 'anchored' : 'plain'])
    openDetail(id)
  } catch (e) { toast('提交失败: ' + e.message); LOG.rec('error', ['review.comment.fail', id, e.message]) }
}

// ── 单条审判 ──────────────────────────────────────────────────────────────────
async function doVerdict(id, v) {
  try {
    await apiJson(S.verdictPath(id), 'POST', S.buildVerdictPayload(v))
    toast(verdictDoneLabel(v))
    LOG.rec('info', ['review.verdict', id, v])
    if (curMaterial && String(curMaterial.id) === String(id)) {
      curMaterial.status = v
      syncVerdictEcho()      // 选中回显
      stampVerdict(v)        // 裁决=盖章(通过/驳回;搁置回邮票格)
    }
    setTimeout(() => { if (isListShown()) loadList() }, 500)
  } catch (e) { toast('操作失败: ' + e.message); LOG.rec('error', ['review.verdict.fail', id, v, e.message]) }
}

// ── WS 回流(复用 openReconnectingWs):审判/批注后列表与详情自动更新 ───────────
// 列表是否刷新只看「列表容器是否可见」(isListShown),不用 isDetail() 取反 ——
// 平板 ≥840 双栏时列表与详情同屏可见,两者需分别独立判断,不能互相取反。
function ensureWs() {
  if (conn || !store.base) return
  try {
    conn = openReconnectingWs(S.streamWsUrl(store.base), {
      onOpen: () => LOG.rec('info', ['review.ws.open']),
      onFrame: (f) => onReviewFrame(f),
      onError: () => LOG.rec('error', ['review.ws.error']),
    })
  } catch (e) { LOG.rec('error', ['review.ws.ctor', e.message || e]) }
}
function isDetail() {
  const el = document.getElementById('reviewDetailView')
  return !!(el && el.classList.contains('show'))
}
function isListShown() {
  const el = document.getElementById('reviewView')
  return !!(el && el.classList.contains('show'))
}
function onReviewFrame(f) {
  if (!S.isReviewEvent(f)) return
  const id = S.reviewEventId(f)
  LOG.rec('info', ['review.ws.event', S.reviewEventType(f), id])
  if (isDetail() && curMaterial && id != null && String(id) === String(curMaterial.id)) {
    openDetail(curMaterial.id)
  }
  if (isListShown()) {
    if (_refreshTimer) clearTimeout(_refreshTimer)
    _refreshTimer = setTimeout(() => { _refreshTimer = null; if (!sel.mode) loadList() }, 400)
  }
}
export function reconnectNow() { return conn ? conn.reconnectNow() : false }
export function leaveWs() { if (conn) { try { conn.leave() } catch (e) {} conn = null } }
