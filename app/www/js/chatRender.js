// chatRender.js — 把 normalizedChat 的 state.items 渲染进 #msgs。
//
// 键控复用(node 按 item.id 复用): 流式只改 textContent 不重建 DOM, 折叠态留在
// node 上跨重渲染保留。对齐电脑端 ChatMessage/ToolCallCard 的工具卡形态:
// 标题=toolName, 入参折叠区, 结果折叠区(error 标红), 状态 running/done/error。

import { esc } from './core.js'

function safeJsonPretty(v) {
  try { return JSON.stringify(v, null, 2) } catch (e) { return String(v) }
}

export function renderChat(container, state) {
  if (!container) return
  const nodes = container.__nodes || (container.__nodes = Object.create(null))
  const seen = Object.create(null)

  for (const item of state.items) {
    let node = nodes[item.id]
    if (!node) { node = createNode(item); nodes[item.id] = node }
    node._update(item)
    container.appendChild(node)   // 已存在则移动到末尾, 维持顺序
    seen[item.id] = true
  }
  // 移除已不在 state 的旧节点
  for (const id in nodes) {
    if (!seen[id]) { try { container.removeChild(nodes[id]) } catch (e) {} delete nodes[id] }
  }
}

function createNode(item) {
  switch (item.type) {
    case 'user': return bubble('user')
    case 'assistant': return bubble('ai')
    case 'system': return systemNode()
    case 'thinking': return thinkingNode()
    case 'tool': return toolNode()
    case 'context': return contextNode()
    default: return bubble('ai')
  }
}

function bubble(cls) {
  const d = document.createElement('div')
  d.className = 'msg ' + cls
  d._update = (item) => {
    d.textContent = item.text || ''
    d.classList.toggle('streaming', !!item.streaming)
  }
  return d
}

function systemNode() {
  const d = document.createElement('div')
  d.className = 'msg sys'
  d._update = (item) => {
    d.textContent = item.text || ''
    d.classList.toggle('err', item.level === 'error')
  }
  return d
}

function thinkingNode() {
  const wrap = document.createElement('div')
  wrap.className = 'think'
  const head = document.createElement('div'); head.className = 'think-h'
  const body = document.createElement('div'); body.className = 'think-b'
  wrap.appendChild(head); wrap.appendChild(body)
  wrap._open = false
  head.onclick = () => { wrap._open = !wrap._open; sync() }
  function sync() {
    head.textContent = (wrap._open ? '▾ ' : '▸ ') + '思考过程'
    body.style.display = wrap._open ? 'block' : 'none'
  }
  wrap._update = (item) => { body.textContent = item.text || ''; sync() }
  return wrap
}

function toolNode() {
  const wrap = document.createElement('div')
  wrap.className = 'tool'
  const head = document.createElement('div'); head.className = 'tool-h'
  const nm = document.createElement('span'); nm.className = 'tool-nm'
  const st = document.createElement('span'); st.className = 'tool-st'
  head.appendChild(nm); head.appendChild(st)
  const inWrap = document.createElement('div'); inWrap.className = 'tool-sec'
  const inHead = document.createElement('div'); inHead.className = 'tool-sec-h'; inHead.textContent = '入参'
  const inBody = document.createElement('pre'); inBody.className = 'tool-sec-b'
  inWrap.appendChild(inHead); inWrap.appendChild(inBody)
  const outWrap = document.createElement('div'); outWrap.className = 'tool-sec'
  const outHead = document.createElement('div'); outHead.className = 'tool-sec-h'; outHead.textContent = '结果'
  const outBody = document.createElement('pre'); outBody.className = 'tool-sec-b'
  outWrap.appendChild(outHead); outWrap.appendChild(outBody)
  wrap.appendChild(head); wrap.appendChild(inWrap); wrap.appendChild(outWrap)

  wrap._inOpen = false; wrap._outOpen = true   // 结果默认展开, 入参默认折叠
  inHead.onclick = () => { wrap._inOpen = !wrap._inOpen; syncFold() }
  outHead.onclick = () => { wrap._outOpen = !wrap._outOpen; syncFold() }
  function syncFold() {
    inHead.textContent = (wrap._inOpen ? '▾ ' : '▸ ') + '入参'
    inBody.style.display = wrap._inOpen ? 'block' : 'none'
    outHead.textContent = (wrap._outOpen ? '▾ ' : '▸ ') + '结果'
    outBody.style.display = wrap._outOpen ? 'block' : 'none'
  }

  wrap._update = (item) => {
    nm.textContent = '🔧 ' + (item.toolName || 'tool')
    if (!item.done) { st.textContent = '运行中'; st.className = 'tool-st running' }
    else if (item.isError) { st.textContent = '出错'; st.className = 'tool-st error' }
    else { st.textContent = '完成'; st.className = 'tool-st done' }
    // 入参
    if (item.input !== undefined && item.input !== null) {
      inWrap.style.display = 'block'
      inBody.textContent = typeof item.input === 'string' ? item.input : safeJsonPretty(item.input)
    } else { inWrap.style.display = 'none' }
    // 结果
    if (item.done) {
      outWrap.style.display = 'block'
      outBody.textContent = item.result != null && item.result !== '' ? String(item.result) : '(无输出)'
      outBody.classList.toggle('err', !!item.isError)
    } else { outWrap.style.display = 'none' }
    syncFold()
  }
  return wrap
}

function contextNode() {
  const d = document.createElement('div')
  d.className = 'ctx'
  d._update = (item) => {
    d.textContent = '📎 ' + (item.summary || 'context') + (item.planId ? ('（' + item.planId + '）') : '')
  }
  return d
}
