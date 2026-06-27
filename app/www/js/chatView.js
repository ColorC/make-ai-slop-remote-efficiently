// chatView.js — 会话 tab 控制器(会话列表 + 单会话对话)。
//
// 把 normalizedChat(纯 reducer)+ chatRender(键控渲染)+ ws(自动重连)+ core(API/UI)
// 接成对齐电脑端的对话面板。职责:
//   · 会话列表: 列/新建/打开
//   · 单会话: WS 接帧 → reducer → renderChat;发消息(slash 原样发)、停止(user.interrupt)、
//     运行中指示、effort/model/compact/rename/active_plan 工具栏、slash 快捷条
//   · 重连: openReconnectingWs 掉线自动重连,服务端重发 snapshot,reducer 清空重建(不重复/不卡运行中)
//
// 本模块只碰会话相关 DOM(#chatList/#convView 内部),不碰 tab/连接外壳(那在 app.js)。

import {
  $, esc, toast, api, apiJson, wsUrl, LOG, showView, setBar, hostLabel,
  promptModal, pickModal, loadingHtml, errorHtml, emptyHtml,
} from './core.js'
import { createChatState, applyFrame, markUserSent, markInterrupting } from './normalizedChat.js'
import { renderChat } from './chatRender.js'
import { openReconnectingWs } from './ws.js'

// 新会话默认工作目录(可在新建弹窗里改)
const DEFAULT_CWD = 'E:/WindowsWorkspace/omnicompany'

// effort 取值(对齐契约: low/medium/high/xhigh/max,default=null)
const EFFORT_OPTS = [
  { value: 'default', label: 'default(默认)' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]
// model 取值随 provider;default=null
function modelOpts(provider) {
  if (provider === 'codex') {
    return [
      { value: 'default', label: 'default(默认)' },
      { value: 'gpt-5-codex', label: 'gpt-5-codex' },
      { value: 'gpt-5', label: 'gpt-5' },
    ]
  }
  return [
    { value: 'default', label: 'default(默认)' },
    { value: 'opus', label: 'opus' },
    { value: 'sonnet', label: 'sonnet' },
    { value: 'haiku', label: 'haiku' },
  ]
}
// slash 快捷条(原样作为 user.message 发,前端不解析)
const SLASH_QUICK = ['/help', '/clear', '/compact', '/context', '/cost']

// ── 模块单例状态 ────────────────────────────────────────────────────────────
let conn = null            // openReconnectingWs 句柄(当前会话)
let chatState = null       // 当前会话 reducer state
let cur = null             // { id, name, provider, effort, model, active_plan }
let _onBack = null         // 返回会话列表回调(由 app.js 注入,负责 tab/barSub)

// ── 会话列表 ────────────────────────────────────────────────────────────────
export async function loadSessions() {
  showView('chatListView')
  const box = $('chatList'); if (box) box.innerHTML = loadingHtml('加载会话…')
  try {
    const d = await api('/api/cc/chat/sessions')
    const items = ((d && d.items) || []).filter((s) => s.kind === 'chat' && !s.archived)
    if (!items.length) { box.innerHTML = emptyHtml('还没有会话,点上面新建一个'); return }
    box.innerHTML = items.map(sessHtml).join('')
    Array.prototype.forEach.call(box.querySelectorAll('.sess'), (el) => {
      el.onclick = () => openConvFromList(el.getAttribute('data-id'), items)
    })
  } catch (e) {
    box.innerHTML = errorHtml(e.message); LOG.rec('error', ['sess.list', e.message || e])
  }
}

function sessHtml(s) {
  const nm = s.name || (s.provider + ' · ' + String(s.id).slice(-6))
  const dir = String(s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || ''
  const eff = s.effort && s.effort !== 'default' ? ' · effort ' + esc(s.effort) : ''
  return '<div class="sess" data-id="' + esc(s.id) + '">' +
    '<div class="nm">' + esc(nm) + '</div>' +
    '<div class="mt">' + esc(s.provider) + ' · ' + (s.alive ? '运行中' : '已结束') +
    (dir ? (' · ' + esc(dir)) : '') + eff + '</div></div>'
}

function openConvFromList(id, items) {
  const s = (items || []).find((x) => String(x.id) === String(id)) || { id }
  openConv({
    id: s.id,
    name: s.name || ((s.provider || 'chat') + ' · ' + String(s.id).slice(-6)),
    provider: s.provider || 'claude_code',
    effort: s.effort || 'default',
    model: s.model || 'default',
    active_plan: s.active_plan || null,
  })
}

export async function newSession(provider) {
  const cwd = await promptModal('新会话工作目录', DEFAULT_CWD)
  if (cwd == null) return
  try {
    toast('正在新建…')
    const s = await apiJson('/api/cc/chat/sessions', 'POST', { provider, cwd: cwd || DEFAULT_CWD })
    openConv({
      id: s.id,
      name: s.name || (provider + ' · ' + String(s.id).slice(-6)),
      provider,
      effort: s.effort || 'default',
      model: s.model || 'default',
      active_plan: s.active_plan || null,
    })
  } catch (e) { toast('新建失败: ' + e.message); LOG.rec('error', ['sess.new', provider, e.message || e]) }
}

// ── 单会话对话 ──────────────────────────────────────────────────────────────
export function openConv(meta) {
  leaveWs()
  cur = Object.assign({ effort: 'default', model: 'default' }, meta)
  chatState = createChatState(cur.id)
  showView('convView')
  setBar(cur.name)
  syncToolbar()
  const msgs = $('msgs'); if (msgs) { msgs.innerHTML = ''; msgs.__nodes = null }
  render()
  setStatusLine('连接中…')

  conn = openReconnectingWs(wsUrl(cur.id), {
    onOpen: () => { LOG.rec('info', ['ws.open', cur.id]); setStatusLine('') },
    onFrame: (f) => onFrame(f),
    onReconnecting: () => { setStatusLine('连接断开,正在重连…(重连后历史会重放,不会重复)') },
    onError: () => { LOG.rec('error', ['ws.error', cur.id]) },
  })
}

function onFrame(f) {
  // compact 或服务端换 id: session_created 把后续 sid 接上(reducer 已更 state.sessionId)
  applyFrame(chatState, f)
  if (f && f.kind === 'session_created' && f.newSessionId) cur.id = f.newSessionId
  render()
}

function render() {
  if (!chatState) return
  renderChat($('msgs'), chatState)
  const m = $('msgs'); if (m) m.scrollTop = m.scrollHeight
  syncRunning()
}

// 运行中指示 + 停止按钮(用户发消息后到 complete 前显示)
function syncRunning() {
  const ind = $('runIndicator'); if (!ind) return
  const running = !!(chatState && chatState.running)
  ind.classList.toggle('show', running)
  const txt = $('runText')
  if (txt) txt.textContent = (chatState && chatState.status) ? chatState.status : '运行中…'
  const send = $('composerSend'); if (send) send.disabled = running
}

// 非运行态的提示行(连接/重连),复用 runIndicator 但不显停止
function setStatusLine(msg) {
  const txt = $('runText'); const ind = $('runIndicator'); const stop = $('btnStop')
  if (!ind) return
  if (msg && !(chatState && chatState.running)) {
    if (txt) txt.textContent = msg
    if (stop) stop.style.display = 'none'
    ind.classList.add('show')
  } else {
    if (stop) stop.style.display = ''
    syncRunning()
  }
}

export function send() {
  const inp = $('composerInput'); if (!inp) return
  const t = (inp.value || '').replace(/\s+$/, '')
  if (!t.trim()) return
  if (!conn || !conn.isOpen()) { toast('会话未连接,正在重连'); return }
  // slash 原样发:/ 开头不特殊解析,作为 user.message 交给后端(claude 自解析)
  markUserSent(chatState, t)
  inp.value = ''; autoGrow(inp)
  const ok = conn.send({ type: 'user.message', content: t, permissionMode: 'bypassPermissions' })
  if (!ok) { toast('发送失败'); chatState.running = false }
  render()
}

export function stop() {
  if (!chatState || !chatState.running) return
  markInterrupting(chatState)
  if (conn) conn.send({ type: 'user.interrupt' })
  render()
}

function sendSlash(cmd) {
  const inp = $('composerInput'); if (inp) { inp.value = cmd; autoGrow(inp) }
  send()
}

// ── 工具栏: effort / model / compact / rename / active_plan ──────────────────
function syncToolbar() {
  const e = $('cvEffort'); if (e) e.textContent = 'effort: ' + (cur.effort || 'default')
  const m = $('cvModel'); if (m) m.textContent = 'model: ' + (cur.model || 'default')
  const p = $('cvPlan'); if (p) p.textContent = cur.active_plan ? ('计划: ' + shortPlan(cur.active_plan)) : '绑定计划'
}
function shortPlan(id) { const s = String(id); return s.length > 16 ? '…' + s.slice(-14) : s }

async function pickEffort() {
  const v = await pickModal('推理强度 effort', EFFORT_OPTS, cur.effort || 'default')
  if (v == null) return
  try {
    const body = { effort: v === 'default' ? null : v }
    const r = await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/metadata', 'PATCH', body)
    cur.effort = r && r.effort != null ? r.effort : v
    syncToolbar()
    // 后端 effort_applied 是字符串(reconnected/after_current_turn/next_turn/unchanged/stored_codex_pending),
    // 不是 boolean。reconnected/unchanged = 即时生效, 其余 = 下一轮生效。
    const applied = r && r.effort_applied
    const immediate = applied === 'reconnected' || applied === 'unchanged'
    toast(immediate ? ('effort = ' + v + '(即时生效)') : ('effort 已设 ' + v + '(下一轮生效)'))
    LOG.rec('info', ['effort.set', v, 'applied', applied])
  } catch (e) { toast('设置 effort 失败: ' + e.message); LOG.rec('error', ['effort.set', e.message || e]) }
}

async function pickModelFn() {
  const v = await pickModal('模型 model', modelOpts(cur.provider), cur.model || 'default')
  if (v == null) return
  try {
    const body = { model: v === 'default' ? null : v }
    const r = await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/metadata', 'PATCH', body)
    cur.model = r && r.model != null ? r.model : v
    syncToolbar()
    toast('model = ' + (cur.model || 'default') + '(下一轮生效)')
    LOG.rec('info', ['model.set', v])
  } catch (e) { toast('设置 model 失败: ' + e.message); LOG.rec('error', ['model.set', e.message || e]) }
}

async function doCompact() {
  if (!cur) return
  try {
    toast('压缩上下文中…')
    const s = await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/compact', 'POST', {})
    // compact 返回新会话 meta,旧的归档 → 切到新会话
    const newId = (s && (s.id || s.sessionId)) || cur.id
    toast('已压缩,切换到新会话')
    LOG.rec('info', ['compact', cur.id, '->', newId])
    openConv({
      id: newId,
      name: (s && s.name) || cur.name,
      provider: (s && s.provider) || cur.provider,
      effort: (s && s.effort) || cur.effort,
      model: (s && s.model) || cur.model,
      active_plan: (s && s.active_plan) || cur.active_plan,
    })
  } catch (e) { toast('压缩失败: ' + e.message); LOG.rec('error', ['compact', e.message || e]) }
}

async function doRename() {
  const v = await promptModal('会话改名', cur.name || '')
  if (v == null) return
  const name = v.trim(); if (!name) return
  try {
    await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/name', 'PATCH', { name })
    cur.name = name; setBar(name)
    toast('已改名'); LOG.rec('info', ['rename', cur.id])
  } catch (e) { toast('改名失败: ' + e.message); LOG.rec('error', ['rename', e.message || e]) }
}

async function bindPlan() {
  const v = await promptModal('绑定 active_plan(计划 id,留空解绑)', cur.active_plan || '')
  if (v == null) return
  const planId = v.trim() || null
  try {
    await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/active_plan', 'PATCH', { plan_id: planId })
    cur.active_plan = planId; syncToolbar()
    toast(planId ? '已绑定计划' : '已解绑计划'); LOG.rec('info', ['active_plan', planId])
  } catch (e) { toast('绑定计划失败: ' + e.message); LOG.rec('error', ['active_plan', e.message || e]) }
}

// ── 离开/刷新 ───────────────────────────────────────────────────────────────
function leaveWs() { if (conn) { try { conn.leave() } catch (e) {} conn = null } }
export function leave() { leaveWs(); chatState = null; cur = null }
export function refresh() { if (cur) openConv(cur) }
export function isActive() { return !!cur }
export function activeName() { return cur ? cur.name : '' }

// ── textarea 自增高 ─────────────────────────────────────────────────────────
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px' }

// ── 事件接线(由 app.js 在启动时调一次) ─────────────────────────────────────
export function initChat(opts) {
  opts = opts || {}
  _onBack = opts.onBack || null
  const send$ = $('composerSend'); if (send$) send$.onclick = send
  const inp = $('composerInput')
  if (inp) {
    inp.addEventListener('input', () => autoGrow(inp))
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
  }
  const stop$ = $('btnStop'); if (stop$) stop$.onclick = stop
  const e1 = $('cvEffort'); if (e1) e1.onclick = pickEffort
  const m1 = $('cvModel'); if (m1) m1.onclick = pickModelFn
  const c1 = $('cvCompact'); if (c1) c1.onclick = doCompact
  const r1 = $('cvRename'); if (r1) r1.onclick = doRename
  const p1 = $('cvPlan'); if (p1) p1.onclick = bindPlan
  const nc = $('newClaude'); if (nc) nc.onclick = () => newSession('claude_code')
  const nx = $('newCodex'); if (nx) nx.onclick = () => newSession('codex')
  // slash 快捷条
  const bar = $('slashBar')
  if (bar) {
    bar.innerHTML = SLASH_QUICK.map((c) => '<button data-cmd="' + esc(c) + '">' + esc(c) + '</button>').join('')
    Array.prototype.forEach.call(bar.querySelectorAll('button'), (b) => {
      b.onclick = () => sendSlash(b.getAttribute('data-cmd'))
    })
  }
}

// 供 app.js 返回键/刷新调用
export function backToList() { leaveWs(); chatState = null; cur = null; if (_onBack) _onBack(); loadSessions() }
