// normalizedChat.js — 纯函数(无 DOM)归一化帧 reducer。
//
// 对齐 ccdaemon 的 normalized_protocol.py wire 帧(kind 判别)。前端只认归一化帧,
// 不认 chat.py 文档里的原始 SDK 帧(kind:assistant/system/result — 已被后端归一化掉)。
//
// 设计成纯状态机, 便于 Vitest / node 单测: 给 state + frame → 改后的 state。
// 渲染层(chatRender.js)只读 state.items 重画, 本模块绝不碰 DOM。
//
// wire 字段(已核实 chat.py):
//   text         { kind, role, content }
//   stream_delta { kind, content }          // 仅 codex 路径增量; claude 走整段 text
//   stream_end   { kind }
//   thinking     { kind, content }
//   tool_use     { kind, toolId, toolName, toolInput|input }
//   tool_result  { kind, toolId, content|resultText|result, isError, exitCode }
//   status       { kind, text, tokens?, canInterrupt?, tokenBudget? }
//   complete     { kind, sessionId, aborted? }   // aborted 仅 codex 路径; claude 正常结束不带 aborted
//   error        { kind, code?, message?, content?|error? }  // claude 中断走 {code:'interrupted', message}; provider 转的走 {content}
//   session_created { kind, newSessionId }
//   context_event   { kind, status, summary, planId }
//   snapshot     { kind, messages:[<以上 kind 的事件>], history:[{role,text}], tokenUsage }
//
// item 形态(渲染层消费):
//   { type:'user',      id, text }
//   { type:'assistant', id, text, streaming }
//   { type:'thinking',  id, text }
//   { type:'tool',      id, toolId, toolName, input, result, isError, done }
//   { type:'system',    id, text, level:'info'|'error' }
//   { type:'context',   id, summary, planId }

export function createChatState(sessionId = null) {
  return {
    sessionId,
    items: [],            // 有序可渲染项
    _byId: Object.create(null),       // id -> item (去重 / 原地更新)
    _toolByToolId: Object.create(null), // toolId -> tool item (use/result 配对)
    streamingId: null,    // 进行中的 AI 流式气泡 id
    running: false,       // 一轮在途(显示运行指示 + 停止按钮)
    aborted: false,
    status: null,         // 最近一条 status 文案
    tokenBudget: null,    // { used, total }
    seq: 0,               // 本地 id 自增
  }
}

// ── 内部小工具 ──────────────────────────────────────────────────────────────

function _put(state, item) {
  const ex = state._byId[item.id]
  if (ex) { Object.assign(ex, item); return ex }
  state._byId[item.id] = item
  state.items.push(item)
  return item
}

function _localId(state, kind) { return `local_${kind}_${state.seq++}` }

function _resultText(f) {
  if (f.content != null) return typeof f.content === 'string' ? f.content : safeJson(f.content)
  if (f.resultText != null) return String(f.resultText)
  if (f.result != null) return typeof f.result === 'string' ? f.result : safeJson(f.result)
  return ''
}
function _isError(f) {
  if (f.isError) return true
  if (f.exitCode != null && Number(f.exitCode) !== 0) return true
  return false
}
function _errText(f) {
  return String(f.content != null ? f.content : (f.error != null ? f.error : (f.message != null ? f.message : 'unknown error')))
}
// 真后端中断路径: claude 中断走 _broadcast_turn_error → error{code:'interrupted', message:'user interrupted'}
// (不是 codex 式 complete{aborted})。据 code 或 message 判定, 显示温和的"(已中断)"info 行而非红色 error。
function _isInterruptError(f) {
  if (f.code === 'interrupted') return true
  const m = String(f.message != null ? f.message : (f.error != null ? f.error : (f.content != null ? f.content : ''))).toLowerCase()
  return /interrupted|user interrupt/.test(m)
}
export function safeJson(v) {
  try { return JSON.stringify(v) } catch (e) { return String(v) }
}

// ── 单条归一化事件 → item(snapshot 重建 与 live 帧共用) ─────────────────────

function _ingest(state, f) {
  const kind = f.kind
  if (kind === 'text') {
    const content = String(f.content || '')
    if (!content.trim()) return
    if (f.role === 'user') {
      _put(state, { type: 'user', id: f.id || _localId(state, 'user'), text: content })
      return
    }
    // assistant: 若正在流式则定稿当前气泡, 否则新气泡
    if (state.streamingId && state._byId[state.streamingId]) {
      const b = state._byId[state.streamingId]
      b.text = content; b.streaming = false
      state.streamingId = null
    } else {
      _put(state, { type: 'assistant', id: f.id || _localId(state, 'ai'), text: content, streaming: false })
    }
    return
  }
  if (kind === 'thinking') {
    const content = String(f.content || '')
    if (!content.trim()) return
    _put(state, { type: 'thinking', id: f.id || _localId(state, 'think'), text: content })
    return
  }
  if (kind === 'tool_use') {
    const toolId = String(f.toolId || '')
    const item = {
      type: 'tool',
      id: toolId ? `tool_${toolId}` : (f.id || _localId(state, 'tool')),
      toolId,
      toolName: String(f.toolName || f.name || 'tool'),
      input: f.toolInput != null ? f.toolInput : (f.input != null ? f.input : {}),
      result: undefined,
      isError: false,
      done: false,
    }
    const merged = _put(state, item)
    if (toolId) state._toolByToolId[toolId] = merged
    return
  }
  if (kind === 'tool_result') {
    const toolId = String(f.toolId || '')
    const card = toolId ? state._toolByToolId[toolId] : null
    if (card) {
      card.result = _resultText(f)
      card.isError = _isError(f)
      card.done = true
    } else {
      // 结果先到 / 无配对 use: 单独建一张已完成卡
      const item = {
        type: 'tool',
        id: toolId ? `tool_${toolId}` : (f.id || _localId(state, 'tool')),
        toolId,
        toolName: String(f.toolName || 'tool'),
        input: undefined,
        result: _resultText(f),
        isError: _isError(f),
        done: true,
      }
      const merged = _put(state, item)
      if (toolId) state._toolByToolId[toolId] = merged
    }
    return
  }
  if (kind === 'error') {
    if (_isInterruptError(f)) {
      // 中断不是错误: 温和 info 行(对齐电脑端"已中断"), 不刷红
      _put(state, { type: 'system', id: f.id || _localId(state, 'abort'), text: '（已中断）', level: 'info' })
      return
    }
    _put(state, { type: 'system', id: f.id || _localId(state, 'err'), text: _errText(f), level: 'error' })
    return
  }
  if (kind === 'context_event') {
    _put(state, {
      type: 'context',
      id: f.id || _localId(state, 'ctx'),
      summary: String(f.summary || f.status || 'context'),
      planId: f.planId || null,
    })
    return
  }
  // 其余 kind 由 applyFrame 的 live 分支处理 / 忽略
}

// ── live 帧 ─────────────────────────────────────────────────────────────────

export function applyFrame(state, f) {
  if (!f || typeof f !== 'object') return state
  const kind = f.kind

  switch (kind) {
    case 'snapshot':
      return applySnapshot(state, f)

    case 'stream_delta': {
      if (!state.streamingId || !state._byId[state.streamingId]) {
        const id = _localId(state, 'stream')
        _put(state, { type: 'assistant', id, text: '', streaming: true })
        state.streamingId = id
      }
      const b = state._byId[state.streamingId]
      b.text += String(f.content || '')
      b.streaming = true
      return state
    }

    case 'stream_end': {
      if (state.streamingId && state._byId[state.streamingId]) {
        state._byId[state.streamingId].streaming = false
      }
      state.streamingId = null
      return state
    }

    case 'text':
    case 'thinking':
    case 'tool_use':
    case 'tool_result':
    case 'error':
    case 'context_event':
      _ingest(state, f)
      if (kind === 'error') {
        // claude 中断 = error{code:'interrupted'}: 复位 running + streaming, 标 aborted
        // (后端不再补发 complete; 必须在 error 分支收口运行态)。普通 error 也复位 running。
        if (_isInterruptError(f)) {
          if (state.streamingId && state._byId[state.streamingId]) state._byId[state.streamingId].streaming = false
          state.streamingId = null
          state.aborted = true
          state.status = null
        }
        state.running = false
      }
      return state

    case 'status': {
      if (f.text === 'token_budget' && f.tokenBudget) {
        state.tokenBudget = f.tokenBudget
        return state
      }
      if (f.tokenBudget) state.tokenBudget = f.tokenBudget
      if (f.text === 'rate_limited') {
        _put(state, { type: 'system', id: _localId(state, 'rl'), text: '（已限流，稍候再试）', level: 'info' })
      } else if (f.text) {
        state.status = String(f.text)
      }
      return state
    }

    case 'complete': {
      if (state.streamingId && state._byId[state.streamingId]) {
        state._byId[state.streamingId].streaming = false
      }
      state.streamingId = null
      state.running = false
      state.status = null
      state.aborted = Boolean(f.aborted)
      if (f.aborted) _put(state, { type: 'system', id: _localId(state, 'abort'), text: '（已中断）', level: 'info' })
      return state
    }

    // 后端 _broadcast_turn_error 在 error 后补发 {kind:'result', is_error:true} 收口本轮。
    // 不渲染(运行态已由 error 分支复位), 仅兜底复位 running 防 error 帧缺失时卡 loading。
    case 'result':
      state.running = false
      state.streamingId = null
      return state

    case 'session_created':
      if (f.newSessionId) state.sessionId = f.newSessionId
      return state

    case 'exit':
      state.running = false
      state.streamingId = null
      _put(state, { type: 'system', id: _localId(state, 'exit'), text: '会话已结束: ' + (f.reason || 'ended'), level: 'info' })
      return state

    // permission_request / permission_cancelled / interactive_prompt / system 等: v1 忽略(bypassPermissions)
    default:
      return state
  }
}

// Apply a snapshot into a temporary state, then replace atomically after validation.

function _replaceState(target, source) {
  target.sessionId = source.sessionId
  target.items = source.items
  target._byId = source._byId
  target._toolByToolId = source._toolByToolId
  target.streamingId = source.streamingId
  target.running = source.running
  target.aborted = source.aborted
  target.status = source.status
  target.tokenBudget = source.tokenBudget
  target.seq = source.seq
  return target
}

function _itemKey(item) {
  if (!item) return ''
  if (item.type === 'tool' && item.toolId) return 'tool:' + item.toolId
  if (item.type === 'context') return 'context:' + String(item.summary || '') + ':' + String(item.planId || '')
  if (item.type === 'tool') return 'tool:' + String(item.toolName || '') + ':' + safeJson(item.input) + ':' + String(item.result || '')
  return String(item.type || '') + ':' + String(item.text || '')
}

function _mergePartialSnapshot(state, next) {
  // Match by stable server id first. Legacy snapshots may not carry ids, so use
  // occurrence counts rather than a Set; repeated identical prompts are valid.
  const semanticCounts = new Map()
  const takeSemantic = (key) => {
    if (!key) return false
    const count = semanticCounts.get(key) || 0
    if (!count) return false
    if (count === 1) semanticCounts.delete(key)
    else semanticCounts.set(key, count - 1)
    return true
  }
  for (const item of state.items) {
    const key = _itemKey(item)
    if (key) semanticCounts.set(key, (semanticCounts.get(key) || 0) + 1)
  }
  for (const item of next.items) {
    const existing = state._byId[item.id]
    if (existing) {
      takeSemantic(_itemKey(existing))
      Object.assign(existing, item)
      if (existing.type === 'tool' && existing.toolId) state._toolByToolId[existing.toolId] = existing
      continue
    }
    const key = _itemKey(item)
    if (takeSemantic(key)) continue
    const added = _put(state, Object.assign({}, item))
    if (added.type === 'tool' && added.toolId) state._toolByToolId[added.toolId] = added
  }
  state.running = next.running
  state.aborted = next.aborted
  state.status = next.status
  state.tokenBudget = next.tokenBudget
  state.seq = Math.max(state.seq, next.seq)
  if (next.streamingId && state._byId[next.streamingId]) state.streamingId = next.streamingId
  else if (!next.running) state.streamingId = null
  return state
}

export function applySnapshot(state, snap) {
  snap = snap || {}
  const messages = Array.isArray(snap.messages) ? snap.messages : []
  const history = Array.isArray(snap.history) ? snap.history : []
  const hasRecords = messages.length > 0 || history.length > 0

  // Do not let an empty or partial snapshot erase history already visible to the user.
  // Status-only snapshots still update runtime state without replacing the item list.
  if (!hasRecords && state.items.length) {
    if (snap.tokenUsage) state.tokenBudget = snap.tokenUsage
    return state
  }

  const next = createChatState(state.sessionId)
  next.seq = state.seq
  next.tokenBudget = snap.tokenUsage || state.tokenBudget

  // Prefer normalized messages when present, otherwise consume legacy history entries.
  if (messages.length) {
    for (const m of messages) _ingest(next, m)
  } else {
    for (const h of history) {
      const text = String(h.text != null ? h.text : (h.content != null ? h.content : ''))
      if (!text.trim()) continue
      _ingest(next, {
        id: h.id,
        kind: h.kind || 'text',
        role: h.role === 'user' ? 'user' : 'assistant',
        content: text,
      })
    }
  }

  // Preserve local user messages that the server has not echoed yet.
  // Deduplicate preserved local messages against user text already in server history.
  const serverUserTextCounts = new Map()
  for (const item of next.items) {
    if (item.type !== 'user') continue
    const text = String(item.text || '')
    serverUserTextCounts.set(text, (serverUserTextCounts.get(text) || 0) + 1)
  }
  for (const item of state.items) {
    if (item.type !== 'user' || String(item.id || '').indexOf('local_user_') !== 0) continue
    const text = String(item.text || '')
    const echoed = serverUserTextCounts.get(text) || 0
    if (echoed > 0) {
      if (echoed === 1) serverUserTextCounts.delete(text)
      else serverUserTextCounts.set(text, echoed - 1)
      continue
    }
    _put(next, Object.assign({}, item))
  }

  // HTTP fallback may preserve a live streaming item and runtime status.
  if (snap.preserveLiveState && state.running) {
    next.running = true
    next.status = state.status
    next.aborted = state.aborted
    const live = state.streamingId && state._byId[state.streamingId]
    if (live && !next._byId[live.id]) {
      _put(next, Object.assign({}, live))
      next.streamingId = live.id
    }
  }

  // Chat history is append-only in the UI. If a reconnect sends a shorter snapshot,
  // merge its new records into the complete visible history instead of shrinking it.
  if (snap.preserveExistingHistory && state.items.length > next.items.length) {
    return _mergePartialSnapshot(state, next)
  }
  return _replaceState(state, next)
}

// ── 用户本地回显(发送即上屏, 并进入"运行中") ────────────────────────────────

export function markUserSent(state, text) {
  const item = { type: 'user', id: _localId(state, 'user'), text: String(text) }
  _put(state, item)
  state.running = true
  state.aborted = false
  state.status = null
  return item
}

export function markInterrupting(state) {
  state.status = '正在停止…'
  return state
}
