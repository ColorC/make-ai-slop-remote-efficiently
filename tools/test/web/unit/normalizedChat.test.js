// 归一化帧 reducer 单测 — 覆盖计划点名的 5 个对话痛点核心逻辑。
import { describe, it, expect } from 'vitest'
import {
  createChatState, applyFrame, applySnapshot, markUserSent, markInterrupting,
} from '../../../../app/www/js/normalizedChat.js'

const types = (s) => s.items.map((i) => i.type)
const find = (s, pred) => s.items.find(pred)

describe('stream_delta 合并为单个 assistant 气泡', () => {
  it('多个 delta 累加进同一气泡, 边到边显', () => {
    const s = createChatState('sid')
    applyFrame(s, { kind: 'stream_delta', content: 'Hel' })
    applyFrame(s, { kind: 'stream_delta', content: 'lo ' })
    applyFrame(s, { kind: 'stream_delta', content: 'world' })
    const ai = s.items.filter((i) => i.type === 'assistant')
    expect(ai.length).toBe(1)
    expect(ai[0].text).toBe('Hello world')
    expect(ai[0].streaming).toBe(true)
  })

  it('stream_end 后定稿, text 整段把流式气泡收口而非新建', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'stream_delta', content: 'partial' })
    applyFrame(s, { kind: 'text', role: 'assistant', content: 'partial final' })
    const ai = s.items.filter((i) => i.type === 'assistant')
    expect(ai.length).toBe(1)
    expect(ai[0].text).toBe('partial final')
    expect(ai[0].streaming).toBe(false)
    expect(s.streamingId).toBe(null)
  })
})

describe('thinking 块', () => {
  it('生成可折叠 thinking item, 空内容忽略', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'thinking', content: '让我想想' })
    applyFrame(s, { kind: 'thinking', content: '   ' })
    expect(s.items.filter((i) => i.type === 'thinking').length).toBe(1)
    expect(find(s, (i) => i.type === 'thinking').text).toBe('让我想想')
  })
})

describe('tool_use / tool_result 按 toolId 配对', () => {
  it('use 建 running 卡, result 配对成 done 卡', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_use', toolId: 't1', toolName: 'Bash', input: { command: 'ls' } })
    let card = find(s, (i) => i.type === 'tool')
    expect(card.done).toBe(false)
    expect(card.toolName).toBe('Bash')
    expect(card.input).toEqual({ command: 'ls' })
    applyFrame(s, { kind: 'tool_result', toolId: 't1', resultText: 'a.txt\nb.txt' })
    card = find(s, (i) => i.type === 'tool')
    expect(s.items.filter((i) => i.type === 'tool').length).toBe(1) // 同一张卡, 不新建
    expect(card.done).toBe(true)
    expect(card.isError).toBe(false)
    expect(card.result).toBe('a.txt\nb.txt')
  })

  it('exitCode!=0 标记为 error', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_use', toolId: 't2', toolName: 'Bash', input: {} })
    applyFrame(s, { kind: 'tool_result', toolId: 't2', content: 'boom', exitCode: 1 })
    expect(find(s, (i) => i.type === 'tool').isError).toBe(true)
  })

  it('isError=true 标记为 error', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_use', toolId: 't3', toolName: 'Read' })
    applyFrame(s, { kind: 'tool_result', toolId: 't3', result: 'not found', isError: true })
    expect(find(s, (i) => i.type === 'tool').isError).toBe(true)
  })

  it('result 先到 / 无配对 use 也建一张已完成卡', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_result', toolId: 'orphan', resultText: 'x' })
    const card = find(s, (i) => i.type === 'tool')
    expect(card.done).toBe(true)
    expect(card.result).toBe('x')
  })

  it('同 toolId 的 use 之后 result 不产生重复卡', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_use', toolId: 'dup', toolName: 'Edit' })
    applyFrame(s, { kind: 'tool_use', toolId: 'dup', toolName: 'Edit' }) // 重发
    applyFrame(s, { kind: 'tool_result', toolId: 'dup', resultText: 'ok' })
    expect(s.items.filter((i) => i.type === 'tool').length).toBe(1)
  })
})

describe('error / complete 状态机', () => {
  it('error 落系统红卡并复位 running', () => {
    const s = createChatState()
    markUserSent(s, 'hi')
    expect(s.running).toBe(true)
    applyFrame(s, { kind: 'error', error: '炸了' })
    const sys = find(s, (i) => i.type === 'system')
    expect(sys.level).toBe('error')
    expect(sys.text).toBe('炸了')
    expect(s.running).toBe(false)
  })

  // 真 claude 中断路径: 后端 _broadcast_turn_error 发 error{code:'interrupted', message:'user interrupted'},
  // 不发 complete{aborted}。reducer 要落温和的"(已中断)"info 行(非红色 error)并复位 running。
  it('claude 中断 error{code:interrupted} 落"已中断"info 行(非红色)并复位 running', () => {
    const s = createChatState()
    markUserSent(s, 'hi')
    markInterrupting(s)
    applyFrame(s, { kind: 'error', code: 'interrupted', message: 'user interrupted' })
    const sys = find(s, (i) => i.type === 'system')
    expect(sys.level).toBe('info')         // 不是 error, 不刷红
    expect(/中断/.test(sys.text)).toBe(true)
    expect(s.running).toBe(false)
    expect(s.aborted).toBe(true)
  })

  it('中断 error 后补发的 result 帧不渲染, 仅兜底复位 running', () => {
    const s = createChatState()
    markUserSent(s, 'hi')
    applyFrame(s, { kind: 'error', code: 'interrupted', message: 'user interrupted' })
    const before = s.items.length
    applyFrame(s, { kind: 'result', is_error: true, session_id: 's' })
    expect(s.items.length).toBe(before)    // result 不产生可渲染项
    expect(s.running).toBe(false)
  })

  it('message 含 interrupt 文案(无 code)也判为中断', () => {
    const s = createChatState()
    markUserSent(s, 'hi')
    applyFrame(s, { kind: 'error', message: 'The user interrupted the turn' })
    expect(find(s, (i) => i.type === 'system').level).toBe('info')
    expect(s.running).toBe(false)
  })

  it('complete 复位 running / streaming / status', () => {
    const s = createChatState()
    markUserSent(s, 'hi')
    applyFrame(s, { kind: 'stream_delta', content: 'partial' })
    applyFrame(s, { kind: 'complete', sessionId: 'sid' })
    expect(s.running).toBe(false)
    expect(s.streamingId).toBe(null)
    expect(s.items.find((i) => i.type === 'assistant').streaming).toBe(false)
  })

  // codex 路径兼容: codex 中断走 complete{aborted:true}(claude 不走这个, 走 error{code:interrupted})。
  it('complete aborted=true 落"已中断"系统行(codex 路径)', () => {
    const s = createChatState()
    markUserSent(s, 'hi')
    markInterrupting(s)
    applyFrame(s, { kind: 'complete', aborted: true })
    expect(s.aborted).toBe(true)
    expect(s.items.some((i) => i.type === 'system' && /中断/.test(i.text))).toBe(true)
  })
})

describe('status 帧', () => {
  it('普通 status 更新状态行文案', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'status', text: 'thinking…' })
    expect(s.status).toBe('thinking…')
  })
  it('token_budget 只更新预算不落消息', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'status', text: 'token_budget', tokenBudget: { used: 10, total: 100 } })
    expect(s.tokenBudget).toEqual({ used: 10, total: 100 })
    expect(s.items.length).toBe(0)
  })
})

describe('snapshot 清空重建(重连去重核心)', () => {
  it('snapshot.messages 清空旧列表并据它重建, 复位运行态', () => {
    const s = createChatState('sid')
    // 先制造一个"卡在运行中 + 已有内容"的脏状态
    markUserSent(s, '旧消息')
    applyFrame(s, { kind: 'stream_delta', content: '旧回答' })
    expect(s.running).toBe(true)

    applySnapshot(s, {
      kind: 'snapshot',
      messages: [
        { kind: 'text', role: 'user', content: 'q1' },
        { kind: 'text', role: 'assistant', content: 'a1' },
        { kind: 'tool_use', toolId: 'T', toolName: 'Bash', input: { command: 'ls' } },
        { kind: 'tool_result', toolId: 'T', resultText: 'done' },
      ],
    })
    expect(types(s)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(s.items.at(-1)).toMatchObject({ type: 'user', text: '\u65e7\u6d88\u606f' })
    expect(s.items.some((i) => i.text === '\u65e7\u56de\u7b54')).toBe(false)
    expect(find(s, (i) => i.type === 'tool').done).toBe(true)
    expect(s.running).toBe(false)      // 不卡在运行中
    expect(s.streamingId).toBe(null)
  })

  it('重连重发 snapshot 不产生重复(幂等重建)', () => {
    const s = createChatState('sid')
    const snap = {
      kind: 'snapshot',
      messages: [
        { kind: 'text', role: 'user', content: 'q1' },
        { kind: 'text', role: 'assistant', content: 'a1' },
      ],
    }
    applyFrame(s, snap)
    applyFrame(s, snap) // 断线重连, 服务端再次重发
    expect(s.items.length).toBe(2)
    expect(types(s)).toEqual(['user', 'assistant'])
  })

  it('退回 history([{role,text}]) 也能重建', () => {
    const s = createChatState()
    applySnapshot(s, { kind: 'snapshot', history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }] })
    expect(types(s)).toEqual(['user', 'assistant'])
  })

  it('keeps visible history when an empty snapshot arrives', () => {
    const s = createChatState('sid')
    applySnapshot(s, { messages: [
      { id: 'u1', kind: 'text', role: 'user', content: 'q1' },
      { id: 'a1', kind: 'text', role: 'assistant', content: 'a1' },
    ] })
    const before = s.items.map((i) => ({ ...i }))
    applySnapshot(s, { messages: [], history: [], tokenUsage: { used: 5, total: 10 } })
    expect(s.items).toEqual(before)
    expect(s.tokenBudget).toEqual({ used: 5, total: 10 })
  })

  it('keeps full history order after a shorter reconnect snapshot and appends new records', () => {
    const s = createChatState('sid')
    applySnapshot(s, { messages: [
      { id: 'u1', kind: 'text', role: 'user', content: 'q1' },
      { id: 'a1', kind: 'text', role: 'assistant', content: 'a1' },
      { id: 'u2', kind: 'text', role: 'user', content: 'q2' },
      { id: 'a2', kind: 'text', role: 'assistant', content: 'a2' },
    ] })
    applySnapshot(s, { preserveExistingHistory: true, messages: [
      { id: 'u2', kind: 'text', role: 'user', content: 'q2' },
      { id: 'a2', kind: 'text', role: 'assistant', content: 'a2' },
      { id: 'u3', kind: 'text', role: 'user', content: 'q3' },
    ] })
    expect(s.items.map((i) => i.text)).toEqual(['q1', 'a1', 'q2', 'a2', 'q3'])
  })

  it('atomically replaces a short WS history with all 508 HTTP messages', () => {
    const s = createChatState('sid')
    applySnapshot(s, { messages: Array.from({ length: 20 }, (_, i) => ({
      id: 'short-' + i, kind: 'text', role: i % 2 ? 'assistant' : 'user', content: 'short-' + i,
    })) })
    const full = Array.from({ length: 508 }, (_, i) => ({
      id: 'hist-' + i, kind: 'text', role: i % 2 ? 'assistant' : 'user', content: 'message-' + i,
    }))
    applySnapshot(s, { messages: full, preserveExistingHistory: true, preserveLiveState: true })
    expect(s.items).toHaveLength(508)
    expect(s.items[0]).toMatchObject({ id: 'hist-0', text: 'message-0' })
    expect(s.items.at(-1)).toMatchObject({ id: 'hist-507', text: 'message-507' })
    expect(s.items.some((i) => String(i.id).startsWith('short-'))).toBe(false)
  })

})

describe('text role=user 去重(本地已回显的不再重复)', () => {
  it('带 id 的 user text 复用同 item 不重复', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'text', role: 'user', id: 'u1', content: 'hello' })
    applyFrame(s, { kind: 'text', role: 'user', id: 'u1', content: 'hello' })
    expect(s.items.filter((i) => i.type === 'user').length).toBe(1)
  })

  it('deduplicates local user echoes by occurrence count', () => {
    const s = createChatState()
    markUserSent(s, 'same')
    markUserSent(s, 'same')
    applySnapshot(s, { messages: [
      { id: 'server-u1', kind: 'text', role: 'user', content: 'same' },
      { id: 'server-a1', kind: 'text', role: 'assistant', content: 'ack' },
    ] })
    expect(s.items.filter((i) => i.type === 'user' && i.text === 'same')).toHaveLength(2)
    expect(s.items.filter((i) => String(i.id).startsWith('local_user_'))).toHaveLength(1)
  })

})

describe('markUserSent / markInterrupting', () => {
  it('markUserSent 上屏并进入运行中', () => {
    const s = createChatState()
    markUserSent(s, '问题')
    expect(s.items[0]).toMatchObject({ type: 'user', text: '问题' })
    expect(s.running).toBe(true)
  })
  it('markInterrupting 设停止文案', () => {
    const s = createChatState()
    markInterrupting(s)
    expect(s.status).toBe('正在停止…')
  })
})
