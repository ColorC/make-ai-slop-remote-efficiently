// notesView.js — 笔记 tab 控制器(M2)。
//
// 浏览 omni KB(只读)+ 读写 authored 札记, 对齐电脑端笔记面板能看到的范围:
//   · 来源筛选(KB / 札记 / 全部) + 搜索框 + 卡片列表
//   · 详情页 markdown 渲染;KB 明确只读, authored 可编辑 / 归档
//   · 写札记: 新建 authored note(POST), 编辑保存(PUT), 归档(DELETE 软删)
//
// 纯逻辑(路径/payload/卡片归一)在 notesState.js, 本模块只碰 DOM 与 API。
// 复用 core 的 api / mdToHtml / showView / toast / loading-error 片段。失败显可重试错误卡, 不空白。

import {
  $, esc, toast, api, apiJson, mdToHtml, showView, LOG, loadingHtml, emptyHtml,
} from './core.js'
import {
  SOURCES, DEFAULT_SOURCE, AUTHOR, listRequests, kbCard, authoredCard,
  kbNotePath, authoredNotePath, buildCreatePayload, buildUpdatePayload, validateContent,
} from './notesState.js'

// ── 模块状态 ────────────────────────────────────────────────────────────────
let curSource = DEFAULT_SOURCE
let curQ = ''
let curNote = null     // 当前详情 { src, id, raw } —— 供刷新复用
let _retry = null      // 最近一次列表加载(错误卡"重试"复用)

// ── 列表(来源筛选 + 搜索 + 卡片) ────────────────────────────────────────────
export async function loadNotes() {
  showView('notesView')
  renderFilters()
  const inp = $('notesQ'); if (inp) inp.value = curQ
  await runList()
}

function renderFilters() {
  const box = $('notesFilters'); if (!box) return
  box.innerHTML = SOURCES.map((s) =>
    '<div class="chip' + (s.value === curSource ? ' active' : '') + '" data-s="' + s.value + '">' + esc(s.label) + '</div>'
  ).join('')
  Array.prototype.forEach.call(box.children, (c) => {
    c.onclick = () => { curSource = c.getAttribute('data-s'); renderFilters(); runList() }
  })
}

async function runList() {
  const box = $('notesList'); if (!box) return
  box.innerHTML = loadingHtml('加载笔记…')
  _retry = runList
  const reqs = listRequests(curSource, curQ)
  try {
    // 每个来源各发一个请求;任一失败整体走可重试错误卡(不静默空白)。
    const datas = await Promise.all(reqs.map((r) => api(r.path)))
    let cards = []
    reqs.forEach((r, i) => {
      const items = (datas[i] && datas[i].items) || []
      cards = cards.concat(items.map(r.src === 'kb' ? kbCard : authoredCard))
    })
    if (!cards.length) { box.innerHTML = emptyHtml(curQ ? '没有匹配的笔记' : '该来源下暂无笔记'); return }
    box.innerHTML = cards.map(cardHtml).join('')
    Array.prototype.forEach.call(box.querySelectorAll('.card'), (el) => {
      el.onclick = () => openNote(el.getAttribute('data-src'), el.getAttribute('data-id'))
    })
  } catch (e) {
    renderRetry(box, e.message, runList)
    LOG.rec('error', ['notes.list', curSource, curQ, e.message || e])
  }
}

function cardHtml(c) {
  const tag = c.src === 'kb'
    ? '<span class="b kind">KB · 只读</span>'
    : '<span class="b kind">札记 · 可写</span>' +
      (c.status ? '<span class="b st-' + esc(c.status) + '">' + esc(c.status) + '</span>' : '')
  return '<div class="card" data-src="' + esc(c.src) + '" data-id="' + esc(c.id) + '">' +
    '<div class="ttl">' + esc(c.title) + '</div>' +
    '<div class="badges">' + tag + '</div>' +
    (c.sub ? '<div class="meta">' + esc(c.sub) + '</div>' : '') + '</div>'
}

// 可重试错误卡(接口失败时显示, 不空白)
function renderRetry(box, msg, fn) {
  box.innerHTML =
    '<div class="empty">加载失败: ' + esc(msg) + '<br><br>' +
    '<button class="btn" id="notesRetryBtn" style="max-width:180px;margin:0 auto">重试</button></div>'
  const b = $('notesRetryBtn'); if (b) b.onclick = fn
}

// ── 搜索 ────────────────────────────────────────────────────────────────────
function doSearch() {
  const inp = $('notesQ'); curQ = inp ? (inp.value || '').trim() : ''
  runList()
}

// ── 详情(KB 只读 / authored 可写) ───────────────────────────────────────────
export async function openNote(src, id) {
  showView('noteDetailView')
  curNote = { src, id, raw: null }
  const box = $('noteDetail'); if (box) box.innerHTML = loadingHtml('加载内容…')
  try {
    const note = await api(src === 'kb' ? kbNotePath(id) : authoredNotePath(id))
    curNote.raw = note
    if (src === 'kb') renderKbDetail(note)
    else renderAuthoredDetail(note)
  } catch (e) {
    renderRetry($('noteDetail'), e.message, () => openNote(src, id))
    LOG.rec('error', ['notes.detail', src, id, e.message || e])
  }
}

function renderKbDetail(note) {
  const box = $('noteDetail'); if (!box) return
  box.innerHTML =
    '<h2>' + esc(note.title || note.id || '(无标题)') + '</h2>' +
    '<div class="meta"><span class="b kind">KB · 只读</span>' +
    (note.path ? '<span class="b">' + esc(note.path) + '</span>' : '') + '</div>' +
    '<div id="noteContent" class="md"></div>'
  $('noteContent').innerHTML = mdToHtml(note.content)
}

function renderAuthoredDetail(note) {
  const box = $('noteDetail'); if (!box) return
  const status = note.feedback_status || 'saved'
  box.innerHTML =
    '<h2>' + esc(note.title || '(无标题札记)') + '</h2>' +
    '<div class="meta"><span class="b kind">札记 · 可写</span>' +
    '<span class="b st-' + esc(status) + '">' + esc(status) + '</span>' +
    '<span class="b">' + esc(note.author || 'user') + '</span></div>' +
    '<div id="noteContent" class="md"></div>' +
    '<div id="noteActions">' +
    '<button class="act-edit" id="noteEditBtn">编辑</button>' +
    '<button class="act-del" id="noteDelBtn">归档</button>' +
    '</div>'
  $('noteContent').innerHTML = mdToHtml(note.content)
  $('noteEditBtn').onclick = () => renderEditForm(note)
  $('noteDelBtn').onclick = () => doArchive(note.id)
}

// ── 写札记: 新建 / 编辑 表单 ─────────────────────────────────────────────────
export function openCreate() {
  showView('noteDetailView')
  curNote = { src: 'authored', id: null, raw: null }
  renderForm({ title: '写札记', content: '', placeholder: '用 markdown 写一条札记…', onSave: doCreate })
}

function renderEditForm(note) {
  renderForm({
    title: '编辑札记', content: note.content || '',
    onSave: (content) => doUpdate(note.id, content),
    onCancel: () => renderAuthoredDetail(note),
  })
}

function renderForm(opts) {
  const box = $('noteDetail'); if (!box) return
  box.innerHTML =
    '<h2>' + esc(opts.title) + '</h2>' +
    '<textarea id="noteEditArea" placeholder="' + esc(opts.placeholder || '') + '"></textarea>' +
    '<div id="noteActions">' +
    '<button class="act-ok" id="noteSaveBtn">保存</button>' +
    '<button class="act-cancel" id="noteCancelBtn">取消</button>' +
    '</div>'
  const area = $('noteEditArea'); if (area) { area.value = opts.content || ''; setTimeout(() => { try { area.focus() } catch (e) {} }, 30) }
  $('noteSaveBtn').onclick = () => {
    const content = area ? area.value : ''
    if (!validateContent(content)) { toast('内容不能为空'); return }
    opts.onSave(content)
  }
  $('noteCancelBtn').onclick = opts.onCancel || backToList
}

async function doCreate(content) {
  try {
    toast('保存中…')
    const n = await apiJson('/api/boss-sight/notes', 'POST', buildCreatePayload({ content, author: AUTHOR }))
    toast('已保存')
    LOG.rec('info', ['notes.create', n && n.id])
    // 切到"札记"来源, 让新建项可见, 回列表刷新
    curSource = 'authored'; curQ = ''
    loadNotes()
  } catch (e) { toast('保存失败: ' + e.message); LOG.rec('error', ['notes.create', e.message || e]) }
}

async function doUpdate(id, content) {
  try {
    toast('保存中…')
    await apiJson(authoredNotePath(id), 'PUT', buildUpdatePayload({ content, by: AUTHOR }))
    toast('已保存')
    LOG.rec('info', ['notes.update', id])
    loadNotes()   // 回列表并刷新(编辑保存后列表更新)
  } catch (e) { toast('保存失败: ' + e.message); LOG.rec('error', ['notes.update', id, e.message || e]) }
}

async function doArchive(id) {
  try {
    await api(authoredNotePath(id), { method: 'DELETE' })
    toast('已归档')
    LOG.rec('info', ['notes.archive', id])
    loadNotes()
  } catch (e) { toast('归档失败: ' + e.message); LOG.rec('error', ['notes.archive', id, e.message || e]) }
}

// ── 返回 / 刷新 ─────────────────────────────────────────────────────────────
export function backToList() { curNote = null; loadNotes() }
export function refresh() {
  if ($('noteDetailView') && $('noteDetailView').classList.contains('show') && curNote && curNote.id) {
    openNote(curNote.src, curNote.id)
  } else loadNotes()
}
export function isDetail() { return !!($('noteDetailView') && $('noteDetailView').classList.contains('show')) }

// ── 静态控件接线(app.js 启动时调一次) ──────────────────────────────────────
export function initNotes() {
  const btn = $('notesQBtn'); if (btn) btn.onclick = doSearch
  const inp = $('notesQ')
  if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch() } })
  const nw = $('notesNew'); if (nw) nw.onclick = openCreate
}
