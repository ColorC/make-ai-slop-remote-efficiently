// reviewView.js — 审阅 tab(列表 / 详情 / 审判 / 评论 / 批注 / 批量动作)。M4。
//
// 在已有 列表/详情/markdown/html/image/video/审判 基础上补齐电脑端审阅台:
//   1) 列表多选 → batch_verdict 批量审判 / batch_delete 批量删除(二次确认 + 局部失败提示)
//   2) include_archived 归档筛选切换(默认沿用电脑端不含归档)
//   3) _stats 角标(mandatory_unaccepted / pushed_unread / pending)顶部展示
//   4) 批注定位: image 归一化坐标覆盖层标注点/框; markdown 行号定位+高亮+滚动到批注行
//   5) key_question(inline_content 是 JSON)解析成问题+选项+说明; custom_web_template
//      (filetree_diff 等)兜底: iframe + 通用卡片(标题/说明/字段/链接), 不空白
//   6) 审判/批注后 WS /stream 事件回流刷新列表与详情(复用任务 1 的 openReconnectingWs)
// 网页材料的"实时 URL"在 extra.live_url(html/custom_web_template), 不是独立 kind。
//
// 纯逻辑(选择 reducer / 批量 payload / include_archived / 角标 / 坐标归一 / 行号定位 /
// 模板兜底 / WS 事件判别)在 reviewState.js, 本模块只碰 DOM 与 API。
// 复用 core 的 api / apiJson / mdToHtml / showView / toast / 确认/输入弹窗 / loading-error 片段。

import {
  $, esc, toast, api, apiJson, mdToHtml, showView, store, LOG,
  loadingHtml, errorHtml, emptyHtml, confirmModal, promptModal,
} from './core.js'
import { openReconnectingWs } from './ws.js'
import * as S from './reviewState.js'

// ── 模块状态 ────────────────────────────────────────────────────────────────
let curFilter = S.DEFAULT_FILTER
let includeArchived = false
let curMaterial = null
let sel = S.SELECTION_INIT          // 多选 reducer 状态
let lastItems = []                  // 当前列表项(全选/批量用)
let conn = null                     // 审阅 WS 句柄
let _refreshTimer = null            // WS 回流的列表刷新去抖
let annotateMode = false            // 图片批注采点模式

// ── 列表加载 ────────────────────────────────────────────────────────────────
export async function loadList() {
  ensureWs()
  showView('listView')
  renderStats()                      // 异步, 不阻塞列表
  renderFilters()
  renderSelectBar()
  const box = $('list'); if (box) box.innerHTML = loadingHtml()
  try {
    const data = await api(S.listPath({ status: curFilter, include_archived: includeArchived }))
    const items = (data && data.items) || []
    lastItems = items
    if (!items.length) { box.innerHTML = emptyHtml('该筛选下暂无材料'); renderSelectBar(); return }
    box.innerHTML = items.map(cardHtml).join('')
    Array.prototype.forEach.call(box.querySelectorAll('.card'), (el) => {
      const id = el.getAttribute('data-id')
      el.onclick = () => {
        if (sel.mode) { toggleSelect(id) } else { openDetail(id) }
      }
      const cb = el.querySelector('.selbox')
      if (cb) cb.onclick = (e) => { e.stopPropagation(); toggleSelect(id) }
    })
    renderSelectBar()
  } catch (e) { box.innerHTML = errorHtml(e.message); LOG.rec('error', ['list.fail', e.message]) }
}

// ── 顶部 _stats 角标 ──────────────────────────────────────────────────────────
async function renderStats() {
  const box = $('reviewStats'); if (!box) return
  try {
    const st = await api(S.statsPath())
    const badges = S.statsBadges(st)
    box.innerHTML = badges.map((b) =>
      '<span class="rstat' + (b.count ? ' on' : '') + '" data-k="' + esc(b.key) + '">' +
      esc(b.label) + ' <b>' + b.count + '</b></span>'
    ).join('')
  } catch (e) { box.innerHTML = ''; LOG.rec('error', ['stats.fail', e.message || e]) }
}

// ── 筛选条(状态 chips + 归档开关 + 多选开关) ────────────────────────────────
function renderFilters() {
  const box = $('filters'); if (!box) return
  const chips = S.FILTERS.map((f) =>
    '<div class="chip' + (f[0] === curFilter ? ' active' : '') + '" data-f="' + f[0] + '">' + esc(f[1]) + '</div>'
  ).join('')
  box.innerHTML = chips +
    '<div class="chip-sep"></div>' +
    '<div class="chip arc' + (includeArchived ? ' active' : '') + '" id="chipArchived">含归档</div>' +
    '<div class="chip sel' + (sel.mode ? ' active' : '') + '" id="chipSelect">' + (sel.mode ? '完成' : '多选') + '</div>'
  Array.prototype.forEach.call(box.querySelectorAll('.chip[data-f]'), (c) => {
    c.onclick = () => { curFilter = c.getAttribute('data-f'); sel = S.selectionReducer(sel, { type: 'clear' }); renderFilters(); loadList() }
  })
  $('chipArchived').onclick = () => { includeArchived = !includeArchived; renderFilters(); loadList() }
  $('chipSelect').onclick = () => { sel = S.selectionReducer(sel, { type: sel.mode ? 'exit' : 'enter' }); renderFilters(); loadList() }
}

// ── 多选工具条(批量审判 / 批量删除 / 全选 / 清空) ────────────────────────────
function renderSelectBar() {
  const bar = $('selectBar'); if (!bar) return
  if (!sel.mode) { bar.classList.remove('show'); bar.innerHTML = ''; return }
  bar.classList.add('show')
  const n = S.selCount(sel)
  bar.innerHTML =
    '<span class="selcount">已选 ' + n + '</span>' +
    '<button class="sb-all" id="sbAll">全选</button>' +
    '<button class="sb-ok" data-v="accepted">通过</button>' +
    '<button class="sb-bad" data-v="rejected">驳回</button>' +
    '<button class="sb-block" data-v="blocked">阻断</button>' +
    '<button class="sb-del" id="sbDel">删除</button>'
  Array.prototype.forEach.call(bar.querySelectorAll('button[data-v]'), (b) => {
    b.onclick = () => doBatchVerdict(b.getAttribute('data-v'))
  })
  $('sbAll').onclick = () => {
    const allIds = lastItems.map((m) => m.id)
    const all = S.selCount(sel) >= allIds.length
    sel = all ? S.selectionReducer(sel, { type: 'clear' }) : S.selectionReducer(sel, { type: 'selectAll', ids: allIds })
    syncSelectionDom()
  }
  $('sbDel').onclick = () => doBatchDelete()
}

function toggleSelect(id) {
  sel = S.selectionReducer(sel, { type: 'toggle', id })
  syncSelectionDom()
}
// 只更新勾选态与计数, 不重拉列表。
function syncSelectionDom() {
  const box = $('list'); if (box) {
    Array.prototype.forEach.call(box.querySelectorAll('.card'), (el) => {
      const id = el.getAttribute('data-id')
      el.classList.toggle('picked', S.selHas(sel, id))
      const cb = el.querySelector('.selbox'); if (cb) cb.classList.toggle('on', S.selHas(sel, id))
    })
  }
  renderSelectBar()
}

function cardHtml(m) {
  const t = (m.updated_at || m.created_at || '').replace('T', ' ').slice(0, 16)
  const fl = S.cardFlags(m)
  const picked = S.selHas(sel, m.id)
  return '<div class="card' + (picked ? ' picked' : '') + '" data-id="' + esc(m.id) + '">' +
    (sel.mode ? '<span class="selbox' + (picked ? ' on' : '') + '"></span>' : '') +
    '<div class="ttl">' + esc(m.title || '(无标题)') + '</div>' +
    '<div class="badges">' +
    '<span class="b kind">' + esc(m.kind) + '</span>' +
    '<span class="b tier-' + esc(m.tier) + '">' + esc(m.tier) + '</span>' +
    '<span class="b st-' + esc(m.status) + '">' + esc(m.status) + '</span>' +
    (fl.pushedUnread ? '<span class="b push">新推送</span>' : '') +
    (fl.archived ? '<span class="b arc">归档</span>' : '') +
    (m.source_plan_id ? '<span class="b">' + esc(m.source_plan_id) + '</span>' : '') +
    '</div>' + (t ? '<div class="meta">' + esc(t) + '</div>' : '') + '</div>'
}

// ── 批量动作 ──────────────────────────────────────────────────────────────────
async function doBatchVerdict(v) {
  const ids = S.selIds(sel)
  if (!ids.length) { toast('未选择任何材料'); return }
  const label = { accepted: '通过', rejected: '驳回', blocked: '阻断' }[v] || v
  const ok = await confirmModal('批量' + label + ' ' + ids.length + ' 项？', { okText: label, danger: v !== 'accepted' })
  if (!ok) return
  try {
    const resp = await apiJson(S.batchVerdictPath(), 'POST', S.buildBatchVerdictPayload(ids, v))
    reportBatch(resp, ids, '批量' + label)
    LOG.rec('info', ['batch.verdict', v, ids.length])
    sel = S.selectionReducer(sel, { type: 'clear' })
    await loadList()
  } catch (e) { toast('批量操作失败: ' + e.message); LOG.rec('error', ['batch.verdict.fail', v, e.message]) }
}

async function doBatchDelete() {
  const ids = S.selIds(sel)
  if (!ids.length) { toast('未选择任何材料'); return }
  const ok = await confirmModal('删除选中的 ' + ids.length + ' 项？此操作不可撤销。', { okText: '删除', danger: true })
  if (!ok) return
  try {
    const resp = await apiJson(S.batchDeletePath(), 'POST', S.buildBatchDeletePayload(ids))
    reportBatch(resp, ids, '批量删除')
    LOG.rec('info', ['batch.delete', ids.length])
    sel = S.selectionReducer(sel, { type: 'clear' })
    await loadList()
  } catch (e) { toast('批量删除失败: ' + e.message); LOG.rec('error', ['batch.delete.fail', e.message]) }
}

function reportBatch(resp, ids, label) {
  const sum = S.summarizeBatch(resp, ids)
  const parts = [sum.ok + ' 项已处理']
  if (sum.failed.length) parts.push(sum.failed.length + ' 失败')
  // batch_delete 选中 pending 但未含待审 → 后端按预期跳过, 如实提示(别冒充"已处理")。
  if (sum.skippedPending) parts.push(sum.skippedPending + ' 项待审已跳过(需含待审)')
  toast(label + ': ' + parts.join(', '))
}

// ── 详情 ──────────────────────────────────────────────────────────────────────
export async function openDetail(id) {
  ensureWs()
  showView('detailView')
  const box = $('detail'); if (box) box.innerHTML = loadingHtml()
  try {
    const m = await api(S.detailPath(id))
    curMaterial = m
    if (S.cardFlags(m).pushedUnread) { apiJson(S.markPushedPath(id), 'POST', {}).catch(() => {}) }
    const meta = '<div class="meta"><span class="b kind">' + esc(m.kind) + '</span>' +
      '<span class="b tier-' + esc(m.tier) + '">' + esc(m.tier) + '</span>' +
      '<span class="b st-' + esc(m.status) + '">' + esc(m.status) + '</span>' +
      (m.source_plan_id ? '<span class="b">' + esc(m.source_plan_id) + '</span>' : '') + '</div>'
    box.innerHTML = '<h2>' + esc(m.title || '(无标题)') + '</h2>' + meta +
      '<div id="content">' + loadingHtml('加载内容…') + '</div>' +
      '<div id="comments"></div>' +
      '<div id="actions">' +
      '<button class="act-ok" data-v="accepted">通过</button>' +
      '<button class="act-bad" data-v="rejected">驳回</button>' +
      '<button class="act-block" data-v="blocked">阻断</button>' +
      '<button class="act-cmt" id="actComment">评论</button>' +
      '</div>'
    Array.prototype.forEach.call($('actions').querySelectorAll('button[data-v]'), (b) => {
      b.onclick = () => doVerdict(id, b.getAttribute('data-v'))
    })
    $('actComment').onclick = () => addComment(id, null)
    renderContent(m)
    renderComments(m)
  } catch (e) { box.innerHTML = errorHtml(e.message) }
}

function renderContent(m) {
  const c = $('content')
  try {
    if (S.isImageKind(m.kind)) return renderImage(c, m)
    if (S.isVideoKind(m.kind)) {
      c.className = ''
      c.innerHTML = '<video controls style="max-width:100%" src="' + store.base + S.filePath(m.id) + '"></video>'
      return
    }
    if (S.isKeyQuestionKind(m.kind)) return renderKeyQuestion(c, m)
    if (S.isWebKind(m.kind)) return renderWeb(c, m)
    return renderMarkdown(c, m)
  } catch (e) { c.className = ''; c.innerHTML = '<pre>内容加载失败: ' + esc(e.message) + '</pre>' }
}

// key_question: inline_content 是 JSON, 解析成 问题 + 选项 + 说明(对齐电脑端 KeyQuestionMaterialView)。
// 解析失败退原始文本, 绝不当 markdown 显原始 JSON。
async function renderKeyQuestion(c, m) {
  let text = m.inline_content
  if (text == null) { try { text = await api(S.filePath(m.id)) } catch (e) { text = '' } }
  const kq = S.parseKeyQuestion(text)
  c.className = 'kq'
  if (!kq.ok) { c.innerHTML = '<pre class="kq-raw">' + esc(kq.raw || '(无内容)') + '</pre>'; return }
  const opts = kq.options.map((opt, i) =>
    '<div class="kq-opt"><span class="kq-key">' + String.fromCharCode(65 + i) + '.</span>' + esc(opt) + '</div>'
  ).join('')
  c.innerHTML =
    '<div class="kq-h">关键问题</div>' +
    '<div class="kq-q">' + esc(kq.question || '(无问题)') + '</div>' +
    (opts ? '<div class="kq-opts">' + opts + '</div>' : '') +
    (kq.explanation ? '<details class="kq-exp"><summary>说明</summary><div class="kq-exp-b">' + esc(kq.explanation) + '</div></details>' : '')
}

// 图片 + 批注覆盖层(归一化坐标 → 百分比定位, 自适应缩放)。
function renderImage(c, m) {
  c.className = ''
  const url = store.base + S.filePath(m.id)
  const annos = S.imageAnnotations(m)
  const pts = annos.map((a, i) => {
    const an = a.anchor
    if (an.type === 'rect') {
      return '<div class="anno-rect" data-i="' + i + '" title="' + esc(a.text) + '" ' +
        'style="left:' + (an.x * 100) + '%;top:' + (an.y * 100) + '%;width:' + (an.w * 100) + '%;height:' + (an.h * 100) + '%"></div>'
    }
    return '<div class="anno-pt" data-i="' + i + '" title="' + esc(a.text) + '" ' +
      'style="left:' + (an.x * 100) + '%;top:' + (an.y * 100) + '%">' + (i + 1) + '</div>'
  }).join('')
  c.innerHTML =
    '<div class="imgwrap" id="imgwrap"><img src="' + url + '" alt="">' +
    '<div class="anno-layer" id="annoLayer">' + pts + '</div></div>' +
    '<div class="anno-bar">' +
    '<button class="anno-toggle" id="annoToggle">在图上批注</button>' +
    '<span class="anno-hint" id="annoHint">' + (annos.length ? (annos.length + ' 处批注') : '暂无批注') + '</span>' +
    '</div>' +
    (annos.length ? '<ol class="anno-list">' + annos.map((a, i) =>
      '<li><b>' + (i + 1) + '</b> ' + esc(a.text || '(无说明)') + (a.by ? ' <i>— ' + esc(a.by) + '</i>' : '') + '</li>').join('') + '</ol>' : '')
  $('annoToggle').onclick = () => {
    annotateMode = !annotateMode
    $('annoToggle').classList.toggle('on', annotateMode)
    $('annoHint').textContent = annotateMode ? '点击图片选位置…' : (annos.length + ' 处批注')
    $('imgwrap').classList.toggle('picking', annotateMode)
  }
  $('imgwrap').onclick = (e) => {
    if (!annotateMode) return
    const r = $('imgwrap').getBoundingClientRect()
    const x = S.clamp01((e.clientX - r.left) / (r.width || 1))
    const y = S.clamp01((e.clientY - r.top) / (r.height || 1))
    annotateMode = false; $('imgwrap').classList.remove('picking')
    addComment(m.id, { type: 'point', x, y })
  }
}

// markdown: 有行批注 → 行号定位视图(高亮 + 滚动到首个批注行); 否则普通 md 渲染。
async function renderMarkdown(c, m) {
  let text = m.inline_content
  if (text == null) { try { text = await api(S.filePath(m.id)) } catch (e) { text = '' } }
  const lineAnnos = S.markdownAnnotations(m)
  if (!lineAnnos.length) { c.className = 'md'; c.innerHTML = mdToHtml(text); return }
  c.className = 'mdlines'
  const rows = S.buildMarkdownLines(text, lineAnnos)
  c.innerHTML = rows.map((r) =>
    '<div class="mdline' + (r.annotated ? ' anno' : '') + '" data-line="' + r.n + '">' +
    '<span class="ln">' + r.n + '</span>' +
    '<span class="tx">' + (esc(r.text) || '&nbsp;') + '</span>' +
    (r.annotated ? '<div class="mdnote">' + r.notes.map((a) =>
      esc(a.text || '(无说明)') + (a.by ? ' <i>— ' + esc(a.by) + '</i>' : '')).join('<br>') + '</div>' : '') +
    '</div>').join('')
  const first = S.firstAnnotatedLine(text, lineAnnos)
  if (first) {
    const el = c.querySelector('.mdline[data-line="' + first + '"]')
    if (el && el.scrollIntoView) setTimeout(() => { try { el.scrollIntoView({ block: 'center' }) } catch (e) {} }, 20)
  }
}

// 网页材料: html / live_url → iframe; custom_web_template → iframe + 通用兜底卡(不空白)。
function renderWeb(c, m) {
  c.className = ''
  const url = S.resolveWebUrl(m, store.base)
  let html =
    '<iframe src="' + url + '" referrerpolicy="no-referrer" ' +
    'sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"></iframe>' +
    '<div class="web-bar"><a href="' + url + '" target="_blank" rel="noreferrer">↗ 在浏览器打开</a></div>'
  if (m.kind === 'custom_web_template') {
    const card = S.templateFallbackCard(m, store.base)
    html =
      '<div class="tpl-card">' +
      '<div class="tpl-h">模板: ' + esc(card.template || '(通用)') + '</div>' +
      (card.description ? '<div class="tpl-desc">' + esc(card.description) + '</div>' : '') +
      (card.fields.length
        ? '<div class="tpl-fields">' + card.fields.map((f) =>
          '<div class="tpl-f"><span class="k">' + esc(f.key) + '</span><span class="v">' + esc(f.value) + '</span></div>').join('') + '</div>'
        : '') +
      '</div>' + html
  }
  c.innerHTML = html
}

// ── 评论 / 批注列表(无锚点的普通评论) ───────────────────────────────────────
function renderComments(m) {
  const box = $('comments'); if (!box) return
  const cmts = S.plainComments(m)
  if (!cmts.length) { box.innerHTML = ''; return }
  box.innerHTML = '<div class="cmt-h">评论 ' + cmts.length + '</div>' +
    cmts.map((a) => '<div class="cmt"><div class="cmt-by">' + esc(a.by || '匿名') +
      (a.at ? ' · ' + esc(String(a.at).replace('T', ' ').slice(0, 16)) : '') + '</div>' +
      '<div class="cmt-tx">' + esc(a.text || '') + '</div></div>').join('')
}

async function addComment(id, anchor) {
  const text = await promptModal(anchor ? '批注说明' : '写评论', '', { textarea: true, okText: '提交' })
  if (text == null || !String(text).trim()) return
  try {
    await apiJson(S.commentPath(id), 'POST', S.buildCommentPayload(text, anchor ? { anchor } : {}))
    toast(anchor ? '批注已提交' : '评论已提交')
    LOG.rec('info', ['comment', id, anchor ? 'anchored' : 'plain'])
    openDetail(id)   // 重载详情, 立即看到新批注/评论
  } catch (e) { toast('提交失败: ' + e.message); LOG.rec('error', ['comment.fail', id, e.message]) }
}

// ── 单条审判 ──────────────────────────────────────────────────────────────────
async function doVerdict(id, v) {
  try {
    await apiJson(S.verdictPath(id), 'POST', S.buildVerdictPayload(v))
    toast(S.verdictDone(v))
    LOG.rec('info', ['verdict', id, v])
    setTimeout(() => loadList(), 600)
  } catch (e) { toast('操作失败: ' + e.message); LOG.rec('error', ['verdict.fail', id, v, e.message]) }
}

// ── WS 回流(复用任务 1 openReconnectingWs): 审判/批注后列表与详情自动更新 ───────
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
function onReviewFrame(f) {
  if (!S.isReviewEvent(f)) return
  LOG.rec('info', ['review.ws.event', S.reviewEventType(f), S.reviewEventId(f)])
  // 详情正开着且命中当前材料 → 立刻重载详情
  const id = S.reviewEventId(f)
  if (isDetail() && curMaterial && id != null && String(id) === String(curMaterial.id)) {
    openDetail(curMaterial.id)
  }
  // 列表正显示 → 去抖刷新(批量事件合并)
  if ($('listView') && $('listView').classList.contains('show')) {
    if (_refreshTimer) clearTimeout(_refreshTimer)
    _refreshTimer = setTimeout(() => { _refreshTimer = null; if (!sel.mode) loadList() }, 400)
  }
}
export function leaveWs() { if (conn) { try { conn.leave() } catch (e) {} conn = null } }

export function refresh() {
  if (isDetail() && curMaterial) openDetail(curMaterial.id)
  else loadList()
}
export function isDetail() { return $('detailView').classList.contains('show') }
