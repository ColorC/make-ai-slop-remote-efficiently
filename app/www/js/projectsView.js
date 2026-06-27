// projectsView.js — 项目 tab 控制器(M3)。
//
// 只读工作板, 对齐电脑端 项目工作板 / 任务窗口 / 计划目录的卡片与状态语义:
//   · 内部三页签(项目 / 任务 / 计划) + 状态筛选 + 计划板的项目筛选 + 顶栏刷新
//   · 卡片: 名称 + 状态徽标 + 优先级/活跃时间/关联 plan 数/工作线 等后端已有字段
//   · 只读详情: 项目→工作线 + 关联计划; 任务→长期目标/当前章节/子目标; 计划→元数据 + 文档摘要
//   · 进度真源是 whatnow(未经 dashboard 代理), 前端只展示这三个端点给出的状态, 不写状态
//
// 纯逻辑(端点选择/状态徽标/筛选/卡片归一)在 projectsState.js, 本模块只碰 DOM 与 API。
// 复用 core 的 api / showView / toast / loading-error 片段。失败显可重试错误卡, 不静默空白。
// v2 预留: 点任务详情跳关联会话/审阅(后端有 plan 关联字段, 但本任务不新增写操作/跨页路由)。

import {
  $, esc, api, showView, LOG, loadingHtml, emptyHtml,
} from './core.js'
import {
  BOARDS, DEFAULT_BOARD, statusFilters, statusMeta, shortTime,
  listPath, planDetailPath, projectPlansPath, extractItems,
  projectFilterOptions, normalizeCards, filterByStatus,
} from './projectsState.js'

// ── 模块状态 ────────────────────────────────────────────────────────────────
let curBoard = DEFAULT_BOARD
let curStatus = ''
let curProject = ''          // 计划板的项目筛选(空=全部)
let _projectsData = null     // 缓存 /api/projects, 供计划板的项目筛选 chips 复用
let _cardsById = {}          // 当前列表卡片(供详情复用, 免重复拉取)
let _cur = null              // 当前详情 { board, id }
let _retry = null            // 最近一次列表加载(错误卡"重试"复用)
let _pendingFresh = false    // 顶栏刷新置位一次: 下一次列表加载穿透服务端 index 缓存(?fresh=1)

const BOARD_LABEL = { projects: '项目', quests: '任务', plans: '计划' }

// 只读护栏: 项目板只消费 GET 端点(进度真源是 whatnow, 手机端不写状态)。
// 任何带 method 的写请求都是 bug —— 这里硬拒, 别等真发出去。轻量, 不动 core.js。
function apiGet(path) {
  return api(path, { method: 'GET' })
}

// ── 列表(三页签 + 状态筛选 + 项目筛选 + 卡片) ───────────────────────────────
export async function loadProjects() {
  showView('projectsView')
  renderBoards()
  renderFilters()
  await runList()
}

function renderBoards() {
  const box = $('projectsBoards'); if (!box) return
  box.innerHTML = BOARDS.map((b) =>
    '<div class="chip' + (b.value === curBoard ? ' active' : '') + '" data-b="' + b.value + '">' + esc(b.label) + '</div>',
  ).join('')
  Array.prototype.forEach.call(box.children, (c) => {
    c.onclick = () => {
      curBoard = c.getAttribute('data-b'); curStatus = ''
      renderBoards(); renderFilters(); runList()
    }
  })
}

function renderFilters() {
  const box = $('projectsFilters'); if (!box) return
  const sts = statusFilters(curBoard)
  let html = sts.map((f) =>
    '<div class="chip st' + (f[0] === curStatus ? ' active' : '') + '" data-s="' + esc(f[0]) + '">' + esc(f[1]) + '</div>',
  ).join('')
  if (curBoard === 'plans') {
    const opts = projectFilterOptions(_projectsData)
    html += '<span class="chip-sep"></span>' + opts.map((o) =>
      '<div class="chip pj' + (o.id === curProject ? ' active' : '') + '" data-p="' + esc(o.id) + '">' + esc(o.name) + '</div>',
    ).join('')
  }
  box.innerHTML = html
  Array.prototype.forEach.call(box.querySelectorAll('.chip.st'), (c) => {
    c.onclick = () => { curStatus = c.getAttribute('data-s'); renderFilters(); runList() }
  })
  Array.prototype.forEach.call(box.querySelectorAll('.chip.pj'), (c) => {
    c.onclick = () => { curProject = c.getAttribute('data-p'); renderFilters(); runList() }
  })
}

async function runList() {
  const box = $('projectsList'); if (!box) return
  box.innerHTML = loadingHtml('加载' + (BOARD_LABEL[curBoard] || '') + '…')
  _retry = runList
  // 顶栏刷新置位的 fresh 在本次拉取消费掉(穿透服务端 enrich_projects/build_quests 的 _INDEX_CACHE)。
  const fresh = _pendingFresh; _pendingFresh = false
  try {
    // 计划板需要项目列表填充筛选 chips(首次拉取后回填)。
    if (curBoard === 'plans' && !_projectsData) { await ensureProjectsData(); renderFilters() }
    const data = await apiGet(listPath(curBoard, { project: curProject, fresh }))
    if (curBoard === 'projects') _projectsData = data    // 顺便缓存给计划板的项目筛选
    let cards = normalizeCards(curBoard, extractItems(curBoard, data))
    cards = filterByStatus(cards, curStatus)
    _cardsById = {}
    cards.forEach((c) => { _cardsById[c.id] = c })
    if (!cards.length) { box.innerHTML = emptyHtml(emptyMsg()); return }
    box.innerHTML = cards.map(cardHtml).join('')
    Array.prototype.forEach.call(box.querySelectorAll('.card'), (el) => {
      el.onclick = () => openDetail(el.getAttribute('data-board'), el.getAttribute('data-id'))
    })
  } catch (e) {
    renderRetry(box, e.message, runList)
    LOG.rec('error', ['projects.list', curBoard, curProject, e.message || e])
  }
}

function emptyMsg() {
  if (curBoard === 'plans' && curProject) return '该项目下暂无计划'
  if (curStatus) return '该筛选下暂无' + (BOARD_LABEL[curBoard] || '内容')
  return '暂无' + (BOARD_LABEL[curBoard] || '内容')
}

async function ensureProjectsData() {
  if (_projectsData) return _projectsData
  try { _projectsData = await apiGet('/api/projects') } catch (e) { _projectsData = null }
  return _projectsData
}

// ── 卡片渲染(按工作板分派, 复用同一 .card 结构) ──────────────────────────────
function badge(cls, text) { return '<span class="b ' + cls + '">' + esc(text) + '</span>' }
function statusBadge(status) {
  const m = statusMeta(status)
  return m.label ? '<span class="b ' + m.cls + '">' + esc(m.label) + '</span>' : ''
}
function threadBadges(threads, limit) {
  return (threads || []).slice(0, limit || 4).map((t) => {
    const m = statusMeta(t.status)
    return '<span class="b ' + m.cls + '">' + esc(t.name || '(线)') + (t.stale ? ' ⚠' : '') + '</span>'
  }).join('')
}

function cardHtml(c) {
  if (c.board === 'quests') return questCardHtml(c)
  if (c.board === 'plans') return planCardHtml(c)
  return projectCardHtml(c)
}

function projectCardHtml(c) {
  const meta = '活跃 ' + (shortTime(c.lastActive) || '—') + (c.stale && c.staleReason ? ' · ⚠ ' + c.staleReason : '')
  return '<div class="card" data-board="projects" data-id="' + esc(c.id) + '">' +
    '<div class="ttl">' + (c.pinned ? '📌 ' : '') + esc(c.title) + '</div>' +
    '<div class="badges">' +
    (c.group ? badge('kind', c.group) : '') +
    statusBadge(c.status) +
    badge('', c.planCount + ' 计划') +
    threadBadges(c.threads) +
    '</div>' +
    '<div class="meta">' + esc(meta) + '</div></div>'
}

function questCardHtml(c) {
  return '<div class="card" data-board="quests" data-id="' + esc(c.id) + '">' +
    '<div class="ttl">' + esc(c.title) + '</div>' +
    '<div class="badges">' +
    statusBadge(c.status) +
    (c.group ? badge('kind', c.group) : '') +
    badge('', c.activePlanCount + ' 进行中计划') +
    '</div>' +
    (c.objective ? '<div class="meta">' + esc(c.objective) + '</div>' : '') +
    (c.chapter ? '<div class="meta">当前: ' + esc(c.chapter) + '</div>' : '') + '</div>'
}

function planCardHtml(c) {
  return '<div class="card" data-board="plans" data-id="' + esc(c.id) + '">' +
    '<div class="ttl">' + esc(c.title) + '</div>' +
    '<div class="badges">' +
    statusBadge(c.status) +
    (c.category ? badge('kind', c.category) : '') +
    '</div>' +
    (c.date ? '<div class="meta">' + esc(c.date) + '</div>' : '') + '</div>'
}

// 可重试错误卡(接口失败时显示, 不空白)
function renderRetry(box, msg, fn) {
  box.innerHTML =
    '<div class="empty">加载失败: ' + esc(msg) + '<br><br>' +
    '<button class="btn" id="projectsRetryBtn" style="max-width:180px;margin:0 auto">重试</button></div>'
  const b = $('projectsRetryBtn'); if (b) b.onclick = fn
}

// ── 只读详情(项目 / 任务 / 计划) ────────────────────────────────────────────
export async function openDetail(board, id) {
  _cur = { board, id }
  showView('projectDetailView')
  if (board === 'quests') { renderQuestDetail(_cardsById[id], id); return }
  if (board === 'projects') { await renderProjectDetail(id, _cardsById[id]); return }
  if (board === 'plans') { await renderPlanDetail(id); return }
}

function renderQuestDetail(card, id) {
  const box = $('projectDetail'); if (!box) return
  if (!card) { box.innerHTML = emptyHtml('任务不存在: ' + esc(id)); return }
  const subs = (card.sub || []).map((s) =>
    '<div class="card"><div class="ttl">' + esc(s.title || s.id) + '</div>' +
    (s.date ? '<div class="meta">' + esc(s.date) + '</div>' : '') + '</div>',
  ).join('')
  box.innerHTML =
    '<h2>' + esc(card.title) + '</h2>' +
    '<div class="meta">' + statusBadge(card.status) +
    (card.group ? badge('kind', card.group) : '') +
    badge('', card.activePlanCount + ' 进行中计划') +
    '<span class="b">活跃 ' + esc(shortTime(card.lastActive) || '—') + '</span></div>' +
    (card.objective ? '<div class="md"><p><strong>长期目标</strong></p><p>' + esc(card.objective) + '</p></div>' : '') +
    (card.chapter ? '<div class="md"><p><strong>当前章节</strong></p><p>' + esc(card.chapter) + '</p></div>' : '') +
    '<div class="md"><p><strong>进行中计划</strong></p></div>' +
    (subs || emptyHtml('无进行中计划'))
}

async function renderProjectDetail(id, card) {
  const box = $('projectDetail'); if (!box) return
  const title = card ? card.title : id
  const threads = (card && card.threads || []).map((t) => {
    const m = statusMeta(t.status)
    return '<span class="b ' + m.cls + '">' + esc(t.name || '(线)') + ' · ' + esc(m.label) + (t.stale ? ' ⚠' : '') + '</span>'
  }).join(' ')
  box.innerHTML =
    '<h2>' + (card && card.pinned ? '📌 ' : '') + esc(title) + '</h2>' +
    '<div class="meta">' +
    (card ? statusBadge(card.status) : '') +
    (card && card.group ? badge('kind', card.group) : '') +
    (card ? '<span class="b">活跃 ' + esc(shortTime(card.lastActive) || '—') + '</span>' : '') +
    '</div>' +
    (card && card.stale && card.staleReason ? '<div class="md"><p>⚠ ' + esc(card.staleReason) + '</p></div>' : '') +
    (threads ? '<div class="md"><p><strong>工作线</strong></p></div><div class="badges">' + threads + '</div>' : '') +
    '<div class="md"><p><strong>关联计划</strong></p></div>' +
    '<div id="projDetailPlans">' + loadingHtml('加载关联计划…') + '</div>'
  try {
    const data = await apiGet(projectPlansPath(id))
    const cards = normalizeCards('plans', data.items || [])
    cards.forEach((c) => { _cardsById[c.id] = c })
    const wrap = $('projDetailPlans'); if (!wrap) return
    if (!cards.length) { wrap.innerHTML = emptyHtml('该项目下暂无计划'); return }
    wrap.innerHTML = cards.map(planCardHtml).join('')
    Array.prototype.forEach.call(wrap.querySelectorAll('.card'), (el) => {
      el.onclick = () => openDetail('plans', el.getAttribute('data-id'))
    })
  } catch (e) {
    const wrap = $('projDetailPlans'); if (wrap) wrap.innerHTML = '<div class="empty">关联计划加载失败: ' + esc(e.message) + '</div>'
    LOG.rec('error', ['projects.detail.plans', id, e.message || e])
  }
}

async function renderPlanDetail(id) {
  const box = $('projectDetail'); if (!box) return
  box.innerHTML = loadingHtml('加载计划…')
  try {
    const p = await apiGet(planDetailPath(id))
    const meta = (p && p.meta) || {}
    const archived = !!(p && p.archived)
    const title = p.date && p.topic ? p.date + ' ' + p.topic : (p.topic || id)
    const files = (p && p.files) || []
    const docs = files.filter((f) => f.is_md).map((f) =>
      '<div class="card"><div class="ttl">' + esc(f.path) + '</div>' +
      (f.summary ? '<div class="meta">' + esc(f.summary) + '</div>' : '') + '</div>',
    ).join('')
    // 注: 真后端 get_plan(plans.py) 不返回 category, 仅 {id,topic,date,folder_path,files,archived,meta};
    // 计划类目只在列表/项目关联端点存在, 详情页用 meta.work_type 即可, 不再臆想 p.category。
    box.innerHTML =
      '<h2>' + esc(title) + '</h2>' +
      '<div class="meta">' +
      statusBadge(archived ? 'archived' : (meta.status || 'active')) +
      (meta.work_type ? badge('', String(meta.work_type)) : '') +
      '</div>' +
      '<div class="md"><p><strong>文档</strong></p></div>' +
      (docs || emptyHtml('该计划暂无文档'))
  } catch (e) {
    renderRetry(box, e.message, () => renderPlanDetail(id))
    LOG.rec('error', ['plans.detail', id, e.message || e])
  }
}

// ── 返回 / 刷新 ─────────────────────────────────────────────────────────────
export function backToList() { _cur = null; loadProjects() }
export function refresh() {
  if (isDetail() && _cur) { openDetail(_cur.board, _cur.id); return }
  _projectsData = null   // 顶栏刷新清前端项目缓存(项目筛选 chips 也随之刷新)
  _pendingFresh = true   // 且穿透服务端 index 缓存: 下次列表加载带 ?fresh=1(见 enrich_projects/build_quests fresh)
  loadProjects()
}
export function isDetail() {
  return !!($('projectDetailView') && $('projectDetailView').classList.contains('show'))
}
