// chatView.js — 对话屏(推入页)。
//
// 把 normalizedChat(纯 reducer)+ chatRender(键控渲染)+ ws(自动重连)+ core(API/UI)
// 接成成熟 AI 对话面板:顶栏 pill 会话设置、三态发送单按钮、slash 补全浮层、工具活动卡片、
// 运行指示、其它运行中会话快速切换。数据层资产 normalizedChat.js / ws.js 不改,只消费。
//
// 契约导出:init() / open(meta),meta={id,name,provider,effort,model,active_plan}(见 §9)。

import {
  esc, toast, api, apiJson, wsUrl, LOG, promptModal,
} from './core.js'
import { openSheet, openMenu, icons, banner } from './ui.js'
import * as router from './router.js'
import { createChatState, applyFrame, markUserSent, markInterrupting } from './normalizedChat.js'
import { renderChat } from './chatRender.js'
import { openReconnectingWs } from './ws.js'

// provider 展示名 + 差异化选项
const PROVIDER_LABEL = { claude_code: 'Claude', codex: 'Codex', omni_agent: 'Omni', kimi: 'Kimi', opencode: 'OpenCode' }
function modelOpts(provider) {
  if (provider === 'codex') return ['default', 'gpt-5-codex', 'gpt-5']
  if (provider === 'omni_agent') return ['default']
  if (provider === 'kimi') return ['default', 'kimi-for-coding']
  if (provider === 'opencode') return ['default']
  return ['default', 'opus', 'sonnet', 'haiku']
}
function effortOpts(provider) {
  if (provider === 'codex' || provider === 'kimi' || provider === 'opencode') return ['default', 'minimal', 'low', 'medium', 'high']
  return ['default', 'low', 'medium', 'high', 'xhigh', 'max']   // claude_code
}
// slash 补全候选(原样作为 user.message 发,前端不解析)
const SLASH_CMDS = ['/help', '/clear', '/compact', '/context', '/cost', '/model', '/review', '/init', '/status']

// ── 模块单例 ────────────────────────────────────────────────────────────────
let conn = null
let chatState = null
let cur = null                 // { id, name, provider, effort, model, active_plan }
let els = null                 // 缓存本屏关键节点
let slash = { open: false, list: [], idx: 0 }
let otherTimer = null
let ctxSeen = 0

// ── 初始化(接线一次) ────────────────────────────────────────────────────────
export function init() {
  // 离开 chatView(返回/切 tab/深链他处)即收口 ws 与轮询,防泄漏
  router.onChange(({ view }) => { if (view !== 'chatView') cleanup() })
  // 键盘弹起:保持消息流贴底 + 写 --kb 抬起 composer(第二道保险,对齐 termView.js wireResize 方案)。
  // visualViewport 收缩量 = 键盘高度;WebView 自身 resize 时 innerHeight≈vv.height → kb≈0,
  // 与原生顶起并存不重复(双保险),原有 scrollBottom 逻辑保留。
  if (typeof window !== 'undefined' && window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const view = document.getElementById('chatView')
      if (router.current() !== 'chatView') { if (view) view.style.setProperty('--kb', '0px'); return }
      const vv = window.visualViewport
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      if (view) view.style.setProperty('--kb', kb + 'px')   // chat.css .chat-composer 以 padding-bottom 消费
      scrollBottom()
    })
  }
}

// ── 打开会话(可重复调用:切会话时原地重开) ──────────────────────────────────
export function open(meta) {
  cleanup()
  cur = Object.assign({ provider: 'claude_code', effort: 'default', model: 'default', active_plan: null }, meta || {})
  chatState = createChatState(cur.id)
  ctxSeen = 0
  buildDom()
  render()
  banner('connecting')
  conn = openReconnectingWs(wsUrl(cur.id), {
    onOpen: () => { LOG.rec('info', ['chat.ws.open', cur.id]); banner(null) },
    onFrame: (f) => onFrame(f),
    onReconnecting: () => banner('disconnected'),
    onError: () => LOG.rec('error', ['chat.ws.error', cur.id]),
  })
  startOtherPoll()
}

function cleanup() {
  if (conn) { try { conn.leave() } catch (e) {} conn = null }
  if (otherTimer) { clearInterval(otherTimer); otherTimer = null }
}

// ── DOM 骨架 ────────────────────────────────────────────────────────────────
function buildDom() {
  const view = document.getElementById('chatView')
  view.innerHTML =
    '<div class="lg-nav chat-nav">' +
      '<button class="lg-nav-back" aria-label="返回">' + icons.back + '</button>' +
      '<div class="lg-nav-mid">' +
        '<div class="lg-nav-title" id="chatTitle"></div>' +
        '<button class="lg-pill" id="chatHeadPill"></button>' +
      '</div>' +
      '<div class="lg-nav-actions">' +
        '<button class="lg-icon-btn chat-other" id="chatOther" style="display:none" aria-label="其它运行中会话">' +
          '<span class="chat-other-dot"></span><span class="chat-other-n"></span></button>' +
        '<button class="lg-icon-btn" id="chatMenu" aria-label="更多">' + icons.dots + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="scroll chat-msgs" id="chatMsgs"></div>' +
    '<div class="chat-runline" id="chatRun">' +
      '<span class="chat-run-spin"></span><span class="chat-run-txt"></span><span class="chat-run-budget"></span>' +
    '</div>' +
    '<div class="chat-composer">' +
      '<button class="chat-plus" id="chatPlus" aria-label="更多">' + icons.plus + '</button>' +
      '<div class="chat-input-wrap">' +
        '<textarea id="chatInput" rows="1" placeholder="发消息…" autocapitalize="sentences"></textarea>' +
        '<div class="chat-slash" id="chatSlash"></div>' +
      '</div>' +
      '<button class="chat-send" id="chatSend" aria-label="发送"></button>' +
    '</div>'

  els = {
    title: view.querySelector('#chatTitle'),
    pill: view.querySelector('#chatHeadPill'),
    other: view.querySelector('#chatOther'),
    otherN: view.querySelector('.chat-other-n'),
    menu: view.querySelector('#chatMenu'),
    msgs: view.querySelector('#chatMsgs'),
    run: view.querySelector('#chatRun'),
    runTxt: view.querySelector('.chat-run-txt'),
    runBudget: view.querySelector('.chat-run-budget'),
    input: view.querySelector('#chatInput'),
    send: view.querySelector('#chatSend'),
    plus: view.querySelector('#chatPlus'),
    slash: view.querySelector('#chatSlash'),
  }

  view.querySelector('.lg-nav-back').addEventListener('click', () => { cleanup(); router.pop() })
  els.pill.addEventListener('click', openSettingsSheet)
  els.menu.addEventListener('click', openHeadMenu)
  els.other.addEventListener('click', openOtherSheet)
  els.plus.addEventListener('click', openPlusMenu)
  els.send.addEventListener('click', onSendBtn)
  els.input.addEventListener('input', onInput)
  els.input.addEventListener('keydown', onKeydown)

  syncHead()
  syncSend()
}

// ── 帧 → reducer → 渲染 ──────────────────────────────────────────────────────
function onFrame(f) {
  applyFrame(chatState, f)
  if (f && f.kind === 'session_created' && f.newSessionId) cur.id = f.newSessionId
  render()
}

function render() {
  if (!chatState || !els) return
  renderChat(els.msgs, chatState)
  scrollBottom()
  syncRun()
  syncSend()
  syncContext()
}

function scrollBottom() { if (els && els.msgs) els.msgs.scrollTop = els.msgs.scrollHeight }

// ── 顶栏 ────────────────────────────────────────────────────────────────────
function syncHead() {
  els.title.textContent = cur.name || '对话'
  const p = PROVIDER_LABEL[cur.provider] || cur.provider || ''
  const m = (cur.model && cur.model !== 'default') ? cur.model : '默认'
  const e = (cur.effort && cur.effort !== 'default') ? cur.effort : '默认'
  els.pill.textContent = p + ' · ' + m + ' · ' + e
}

// ── 运行指示行 ──────────────────────────────────────────────────────────────
function syncRun() {
  const running = !!chatState.running
  els.run.classList.toggle('show', running)
  els.runTxt.textContent = chatState.status || '运行中…'
  const b = chatState.tokenBudget
  els.runBudget.textContent = (b && b.used != null && b.total != null) ? (b.used + '/' + b.total + ' tokens') : ''
}

// ── 三态发送单按钮 ──────────────────────────────────────────────────────────
function syncSend() {
  const running = !!(chatState && chatState.running)
  const hasText = !!(els.input.value && els.input.value.trim())
  els.send.classList.toggle('stop', running)
  els.send.classList.toggle('ready', !running && hasText)
  els.send.disabled = !running && !hasText
  els.send.innerHTML = running
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
}

function onSendBtn() { if (chatState && chatState.running) stop(); else send() }

function send() {
  const t = (els.input.value || '').replace(/\s+$/, '')
  if (!t.trim()) return
  if (!conn || !conn.isOpen()) { toast('会话未连接,正在重连', { type: 'err' }); return }
  markUserSent(chatState, t)
  els.input.value = ''; closeSlash(); autoGrow()
  const ok = conn.send({ type: 'user.message', content: t, permissionMode: 'bypassPermissions' })
  if (!ok) { toast('发送失败', { type: 'err' }); chatState.running = false }
  render()
}

function stop() {
  if (!chatState || !chatState.running) return
  markInterrupting(chatState)
  if (conn) conn.send({ type: 'user.interrupt' })
  render()
}

// ── 输入 / 自增高 / slash 补全 ───────────────────────────────────────────────
function onInput() { autoGrow(); syncSend(); refreshSlash() }

function autoGrow() {
  const el = els.input
  el.style.height = 'auto'
  const cs = getComputedStyle(el)
  const line = parseFloat(cs.lineHeight) || 20
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
  const max = line * 6 + pad
  el.style.height = Math.min(el.scrollHeight, max) + 'px'
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
}

function refreshSlash() {
  const v = els.input.value || ''
  const m = v.match(/^\/([\w-]*)$/)   // 仅在纯 slash 命令(未含空格)时补全
  if (!m) { closeSlash(); return }
  const q = '/' + m[1].toLowerCase()
  const list = SLASH_CMDS.filter((c) => c.indexOf(q) === 0)
  if (!list.length) { closeSlash(); return }
  slash = { open: true, list, idx: 0 }
  renderSlash()
}

function renderSlash() {
  els.slash.classList.toggle('show', slash.open)
  if (!slash.open) return
  els.slash.innerHTML = slash.list.map((c, i) =>
    '<button class="chat-slash-item' + (i === slash.idx ? ' on' : '') + '" data-i="' + i + '">' + esc(c) + '</button>').join('')
  Array.prototype.forEach.call(els.slash.querySelectorAll('[data-i]'), (b) => {
    b.addEventListener('click', () => acceptSlash(Number(b.getAttribute('data-i'))))
  })
}

function acceptSlash(i) {
  const c = slash.list[i]; if (!c) return
  els.input.value = c + ' '
  closeSlash(); els.input.focus(); autoGrow(); syncSend()
}

function closeSlash() { slash.open = false; if (els) els.slash.classList.remove('show') }

function onKeydown(e) {
  if (slash.open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slash.idx = (slash.idx + 1) % slash.list.length; renderSlash(); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); slash.idx = (slash.idx - 1 + slash.list.length) % slash.list.length; renderSlash(); return }
    if (e.key === 'Enter') { e.preventDefault(); acceptSlash(slash.idx); return }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}

// ── 会话设置 sheet(点 pill):模型 / 推理强度 ────────────────────────────────
function openSettingsSheet() {
  const provider = cur.provider
  const rows = [{ type: 'header', label: '模型' }]
  modelOpts(provider).forEach((v) => rows.push({
    type: 'radio', label: v === 'default' ? '默认' : v, on: (cur.model || 'default') === v,
    onTap: () => setModel(v),
  }))
  rows.push({ type: 'row', label: '自定义…', chev: true, onTap: (close) => { close(); customModel() } })
  rows.push({ type: 'header', label: '推理强度' })
  if (provider === 'omni_agent') {
    rows.push({ type: 'row', label: '推理强度', value: '不支持', muted: true, disabled: true })
  } else {
    effortOpts(provider).forEach((v) => rows.push({
      type: 'radio', label: v === 'default' ? '默认' : v, on: (cur.effort || 'default') === v,
      onTap: () => setEffort(v),
    }))
  }
  openSheet({ title: '会话设置', rows })
}

async function setModel(v) {
  try {
    const r = await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/metadata', 'PATCH', { model: v === 'default' ? null : v })
    cur.model = (r && r.model != null) ? r.model : (v === 'default' ? 'default' : v)
    syncHead(); toast('模型 ' + (cur.model === 'default' || cur.model == null ? '默认' : cur.model) + '(下一轮生效)')
    LOG.rec('info', ['chat.model', v])
  } catch (e) { toast('设置模型失败: ' + (e.message || e), { type: 'err' }) }
}

function customModel() {
  promptModal('自定义模型', cur.model && cur.model !== 'default' ? cur.model : '').then((v) => {
    if (v == null) return
    const name = v.trim(); if (!name) return
    setModel(name)
  })
}

async function setEffort(v) {
  try {
    const r = await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/metadata', 'PATCH', { effort: v === 'default' ? null : v })
    cur.effort = (r && r.effort != null) ? r.effort : (v === 'default' ? 'default' : v)
    syncHead()
    // effort_applied 是字符串:reconnected/unchanged=即时生效,其余=下一轮生效
    const applied = r && r.effort_applied
    const immediate = applied === 'reconnected' || applied === 'unchanged'
    toast('推理强度 ' + (v === 'default' ? '默认' : v) + (immediate ? '(即时生效)' : '(下一轮生效)'))
    LOG.rec('info', ['chat.effort', v, 'applied', applied])
  } catch (e) { toast('设置推理强度失败: ' + (e.message || e), { type: 'err' }) }
}

// ── 三点菜单:改名 / 绑定计划 / 压缩 / 查看注入上下文 / 归档 ──────────────────
function openHeadMenu() {
  openMenu({
    anchor: els.menu,
    items: [
      { label: '改名', onTap: doRename },
      { label: '绑定计划', onTap: bindPlan },
      { label: '压缩上下文', onTap: doCompact },
      { label: '查看注入上下文', onTap: showContexts },
      { label: '归档', danger: true, onTap: doArchive },
    ],
  })
}

async function doRename() {
  const v = await promptModal('会话改名', cur.name || '')
  if (v == null) return
  const name = v.trim(); if (!name) return
  try {
    await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/name', 'PATCH', { name })
    cur.name = name; syncHead(); toast('已改名')
  } catch (e) { toast('改名失败: ' + (e.message || e), { type: 'err' }) }
}

async function bindPlan() {
  const v = await promptModal('绑定计划(计划 id,留空解绑)', cur.active_plan || '')
  if (v == null) return
  const planId = v.trim() || null
  try {
    await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/active_plan', 'PATCH', { plan_id: planId })
    cur.active_plan = planId; toast(planId ? '已绑定计划' : '已解绑计划')
  } catch (e) { toast('绑定计划失败: ' + (e.message || e), { type: 'err' }) }
}

async function doCompact() {
  try {
    toast('压缩上下文中…')
    const s = await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/compact', 'POST', {})
    const newId = (s && (s.id || s.sessionId)) || cur.id
    LOG.rec('info', ['chat.compact', cur.id, '->', newId])
    toast('已压缩,切换到新会话', { type: 'ok' })
    open({
      id: newId,
      name: (s && s.name) || cur.name,
      provider: (s && s.provider) || cur.provider,
      effort: (s && s.effort) || cur.effort,
      model: (s && s.model) || cur.model,
      active_plan: (s && s.active_plan) || cur.active_plan,
    })
  } catch (e) { toast('压缩失败: ' + (e.message || e), { type: 'err' }) }
}

function showContexts() {
  const ctx = chatState.items.filter((i) => i.type === 'context')
  if (!ctx.length) { toast('尚无注入上下文'); return }
  openSheet({
    title: '注入上下文（' + ctx.length + '）',
    rows: ctx.map((c) => ({ type: 'row', label: c.summary || '上下文', sub: c.planId ? ('计划 ' + c.planId) : '', muted: true })),
  })
}

async function doArchive() {
  try {
    await apiJson('/api/cc/chat/sessions/' + encodeURIComponent(cur.id) + '/metadata', 'PATCH', { archived: true })
    toast('已归档', { type: 'ok' }); cleanup(); router.pop()
  } catch (e) { toast('归档失败: ' + (e.message || e), { type: 'err' }) }
}

// ── 左「+」菜单:查看注入上下文 / 复制会话 id / 滚到底部 ──────────────────────
function openPlusMenu() {
  const ctxN = chatState.items.filter((i) => i.type === 'context').length
  openMenu({
    anchor: els.plus,
    items: [
      { label: '已注入上下文 ' + ctxN, onTap: showContexts },
      { label: '复制会话 id', onTap: copyId },
      { label: '滚到底部', onTap: scrollBottom },
    ],
  })
}

function copyId() {
  try { if (navigator.clipboard) navigator.clipboard.writeText(String(cur.id)) } catch (e) {}
  toast('已复制会话 id')
}

// context 注入:不进流,首次汇成一次 toast 提示
function syncContext() {
  const n = chatState.items.filter((i) => i.type === 'context').length
  if (n > ctxSeen) { toast('已注入上下文 ' + n); ctxSeen = n }
}

// ── 其它运行中会话指示器 + 快速切换 ─────────────────────────────────────────
let otherRunning = []
function startOtherPoll() { pollOthers(); otherTimer = setInterval(pollOthers, 10000) }

async function pollOthers() {
  try {
    const d = await api('/api/cc/chat/sessions')
    const items = ((d && d.items) || []).filter((s) => s.kind === 'chat' && s.running && String(s.id) !== String(cur.id) && !s.archived)
    otherRunning = items
    if (els) {
      els.other.style.display = items.length ? '' : 'none'
      els.otherN.textContent = items.length ? String(items.length) : ''
    }
  } catch (e) { /* 静默:轮询失败不打扰 */ }
}

function openOtherSheet() {
  if (!otherRunning.length) return
  openSheet({
    title: '其它运行中会话',
    rows: otherRunning.map((s) => ({
      type: 'row', chev: true,
      label: s.name || ((PROVIDER_LABEL[s.provider] || s.provider) + ' · ' + String(s.id).slice(-6)),
      sub: (PROVIDER_LABEL[s.provider] || s.provider) + ' · ' + tailDir(s.cwd),
      onTap: (close) => {
        close()
        open({ id: s.id, name: s.name, provider: s.provider, effort: s.effort || 'default', model: s.model || 'default', active_plan: s.active_plan || null })
      },
    })),
  })
}

function tailDir(cwd) { return String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '' }
