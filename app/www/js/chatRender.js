// chatRender.js — 把 normalizedChat 的 state.items 渲染进消息容器。
//
// 键控复用:节点按稳定 key 复用(item.id 或工具聚拢组的合成 key),流式气泡只改
// textContent 不重建 DOM,折叠态留在节点上跨重渲染保留。渲染形态:
//   · user       右对齐气泡
//   · assistant  左侧气泡;定稿后走 core.mdToHtml 渲染 markdown,流式时先纯文本避免逐帧重排
//   · thinking   单行折叠条,点开展开
//   · tool       单行折叠摘要(状态图标 + 工具名 + 入参摘要 + 时长),点开展开入参/结果块
//   · toolgroup  连续 ≥3 张已完成工具卡自动聚拢为「N 个步骤」一行,点开展开该组
//   · system     居中小字(error 标红)
// context 注入项不进流(由 chatView 汇成 toast + 「+」菜单入口)。

import { mdToHtml } from './core.js'
import { icons } from './ui.js'

// 入参摘要挑最有信息量字段:命令/文件/模式/链接优先
const ARG_KEYS = ['command', 'file_path', 'pattern', 'url', 'path', 'query', 'prompt', 'description']

export function renderChat(container, state) {
  if (!container) return
  const nodes = container.__nodes || (container.__nodes = Object.create(null))
  const seen = Object.create(null)
  const slots = planSlots(state.items)
  for (const slot of slots) {
    let node = nodes[slot.key]
    if (!node || node._kind !== slot.kind) {
      node = createSlotNode(slot); node._kind = slot.kind; nodes[slot.key] = node
    }
    node._update(slot)
    container.appendChild(node)   // 已存在则移动到末尾,维持顺序
    seen[slot.key] = true
  }
  for (const k in nodes) {
    if (!seen[k]) { try { container.removeChild(nodes[k]) } catch (e) {} delete nodes[k] }
  }
}

// 排布:跳过 context;把连续 ≥3 张「已完成」工具卡聚拢成一个组槽,防长任务刷屏。
function planSlots(items) {
  const visible = items.filter((i) => i.type !== 'context')
  const slots = []
  let i = 0
  while (i < visible.length) {
    const it = visible[i]
    if (it.type === 'tool' && it.done) {
      let j = i
      while (j < visible.length && visible[j].type === 'tool' && visible[j].done) j++
      const run = visible.slice(i, j)
      if (run.length >= 3) slots.push({ kind: 'toolgroup', key: 'grp:' + run.map((r) => r.id).join('|'), items: run })
      else run.forEach((r) => slots.push({ kind: 'tool', key: r.id, item: r }))
      i = j
      continue
    }
    slots.push({ kind: it.type, key: it.id, item: it })
    i++
  }
  return slots
}

function createSlotNode(slot) {
  switch (slot.kind) {
    case 'user': return userBubble()
    case 'assistant': return aiBubble()
    case 'system': return systemNode()
    case 'thinking': return thinkingNode()
    case 'tool': return toolCard()
    case 'toolgroup': return toolGroup()
    default: return aiBubble()
  }
}

// ── 气泡 ────────────────────────────────────────────────────────────────────
function userBubble() {
  const row = document.createElement('div'); row.className = 'msg-row user'
  const b = document.createElement('div'); b.className = 'msg-bubble user-bubble'
  row.appendChild(b)
  row._update = (slot) => { b.textContent = slot.item.text || '' }
  return row
}

function aiBubble() {
  const row = document.createElement('div'); row.className = 'msg-row ai'
  const b = document.createElement('div'); b.className = 'msg-bubble ai-bubble'
  row.appendChild(b)
  row._md = null   // 上次已渲染的 md 源文本,避免无变化重排
  row._update = (slot) => {
    const it = slot.item
    if (it.streaming) {
      b.classList.add('streaming'); b.classList.remove('md')
      b.textContent = it.text || ''
      row._md = null
    } else {
      b.classList.remove('streaming')
      if (row._md !== it.text) { b.classList.add('md'); b.innerHTML = mdToHtml(it.text || ''); row._md = it.text }
    }
  }
  return row
}

function systemNode() {
  const d = document.createElement('div'); d.className = 'msg-sys'
  d._update = (slot) => { const it = slot.item; d.textContent = it.text || ''; d.classList.toggle('err', it.level === 'error') }
  return d
}

function thinkingNode() {
  const wrap = document.createElement('div'); wrap.className = 'think'
  const head = document.createElement('button'); head.className = 'think-head'
  const body = document.createElement('div'); body.className = 'think-body'
  wrap.appendChild(head); wrap.appendChild(body)
  wrap._open = false
  head.addEventListener('click', () => { wrap._open = !wrap._open; sync() })
  function sync() { head.textContent = (wrap._open ? '▾ ' : '▸ ') + '思考过程'; wrap.classList.toggle('open', wrap._open) }
  wrap._update = (slot) => { body.textContent = slot.item.text || ''; sync() }
  return wrap
}

// ── 工具活动卡片(单行折叠摘要 + 点开展开) ──────────────────────────────────
function toolCard() {
  const wrap = document.createElement('div'); wrap.className = 'tool-card'
  const head = document.createElement('button'); head.className = 'tool-head'
  const ic = document.createElement('span'); ic.className = 'tool-ic'
  const nm = document.createElement('span'); nm.className = 'tool-name'
  const arg = document.createElement('span'); arg.className = 'tool-arg'
  const dur = document.createElement('span'); dur.className = 'tool-dur'
  head.append(ic, nm, arg, dur)

  const body = document.createElement('div'); body.className = 'tool-body'
  const inSec = document.createElement('div'); inSec.className = 'tool-sec'
  const inLbl = document.createElement('div'); inLbl.className = 'tool-sec-l'; inLbl.textContent = '入参'
  const inPre = document.createElement('pre'); inPre.className = 'tool-pre'
  inSec.append(inLbl, inPre)
  const outSec = document.createElement('div'); outSec.className = 'tool-sec'
  const outLbl = document.createElement('div'); outLbl.className = 'tool-sec-l'; outLbl.textContent = '结果'
  const copy = document.createElement('button'); copy.className = 'tool-copy'; copy.textContent = '复制全部'
  const outPre = document.createElement('pre'); outPre.className = 'tool-pre'
  outSec.append(outLbl, copy, outPre)
  body.append(inSec, outSec)
  wrap.append(head, body)

  wrap._open = false
  head.addEventListener('click', () => { wrap._open = !wrap._open; wrap.classList.toggle('open', wrap._open) })
  copy.addEventListener('click', (e) => {
    e.stopPropagation()
    try { if (navigator.clipboard) navigator.clipboard.writeText(outPre.textContent || '') } catch (x) {}
  })

  wrap._t0 = null; wrap._durText = ''
  wrap._update = (slot) => {
    const it = slot.item
    wrap.classList.toggle('running', !it.done)
    wrap.classList.toggle('error', !!(it.done && it.isError))
    wrap.classList.toggle('ok', !!(it.done && !it.isError))
    ic.innerHTML = !it.done ? '' : (it.isError ? icons.close : icons.check)   // 运行中转圈由 CSS 画
    nm.textContent = it.toolName || 'tool'
    arg.textContent = trunc(argSummary(it.input), 48)
    if (!it.done) { if (wrap._t0 == null) wrap._t0 = Date.now() }
    else if (wrap._t0 != null && !wrap._durText) { wrap._durText = fmtDur(Date.now() - wrap._t0) }
    dur.textContent = wrap._durText || ''
    if (it.input !== undefined && it.input !== null) {
      inSec.style.display = ''
      inPre.textContent = typeof it.input === 'string' ? it.input : pretty(it.input)
    } else inSec.style.display = 'none'
    if (it.done) {
      outSec.style.display = ''
      outPre.textContent = (it.result != null && it.result !== '') ? String(it.result) : '(无输出)'
      outPre.classList.toggle('err', !!it.isError)
    } else outSec.style.display = 'none'
  }
  return wrap
}

function toolGroup() {
  const wrap = document.createElement('div'); wrap.className = 'tool-group'
  const head = document.createElement('button'); head.className = 'tool-group-head'
  const body = document.createElement('div'); body.className = 'tool-group-body'
  wrap.append(head, body)
  wrap._open = false
  wrap.__nodes = Object.create(null)
  head.addEventListener('click', () => { wrap._open = !wrap._open; wrap.classList.toggle('open', wrap._open) })
  wrap._update = (slot) => {
    head.textContent = slot.items.length + ' 个步骤'
    const nodes = wrap.__nodes, seen = Object.create(null)
    for (const it of slot.items) {
      let n = nodes[it.id]
      if (!n) { n = toolCard(); nodes[it.id] = n }
      n._update({ item: it }); body.appendChild(n); seen[it.id] = true
    }
    for (const k in nodes) { if (!seen[k]) { try { body.removeChild(nodes[k]) } catch (e) {} delete nodes[k] } }
  }
  return wrap
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function argSummary(input) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  for (const k of ARG_KEYS) { if (input[k] != null && input[k] !== '') return String(input[k]) }
  for (const k in input) { const v = input[k]; if (typeof v === 'string' && v) return v }
  return ''
}
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s }
function pretty(v) { try { return JSON.stringify(v, null, 2) } catch (e) { return String(v) } }
function fmtDur(ms) {
  if (!(ms >= 0)) return ''
  if (ms < 1000) return ms + 'ms'
  const s = ms / 1000
  return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's'
}
