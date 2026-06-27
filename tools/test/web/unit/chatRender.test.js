// @vitest-environment jsdom
// chatRender 渲染单测 — 键控复用、工具卡形态、流式增量只改文本不重建 DOM。
import { describe, it, expect, beforeEach } from 'vitest'
import { createChatState, applyFrame, markUserSent } from '../../../../app/www/js/normalizedChat.js'
import { renderChat } from '../../../../app/www/js/chatRender.js'

let host
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host) })

describe('renderChat 基础渲染', () => {
  it('user/assistant 气泡按序渲染, class 正确', () => {
    const s = createChatState()
    markUserSent(s, '你好')
    applyFrame(s, { kind: 'text', role: 'assistant', content: '在的' })
    renderChat(host, s)
    const msgs = host.querySelectorAll('.msg')
    expect(msgs.length).toBe(2)
    expect(msgs[0].classList.contains('user')).toBe(true)
    expect(msgs[0].textContent).toBe('你好')
    expect(msgs[1].classList.contains('ai')).toBe(true)
    expect(msgs[1].textContent).toBe('在的')
  })

  it('流式增量复用同一 DOM 节点(不重建)', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'stream_delta', content: 'A' })
    renderChat(host, s)
    const node1 = host.querySelector('.msg.ai')
    expect(node1.classList.contains('streaming')).toBe(true)
    applyFrame(s, { kind: 'stream_delta', content: 'B' })
    renderChat(host, s)
    const node2 = host.querySelector('.msg.ai')
    expect(node2).toBe(node1)              // 同一节点被复用
    expect(node2.textContent).toBe('AB')
    applyFrame(s, { kind: 'complete' })
    renderChat(host, s)
    expect(node1.classList.contains('streaming')).toBe(false)
  })
})

describe('工具卡渲染', () => {
  it('toolName 作标题, 入参/结果折叠区, 状态 running→done', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_use', toolId: 't1', toolName: 'Bash', input: { command: 'ls -la' } })
    renderChat(host, s)
    let tool = host.querySelector('.tool')
    expect(tool.querySelector('.tool-nm').textContent).toContain('Bash')
    expect(tool.querySelector('.tool-st').classList.contains('running')).toBe(true)
    expect(tool.querySelector('.tool-sec-b').textContent).toContain('ls -la') // 入参区

    applyFrame(s, { kind: 'tool_result', toolId: 't1', resultText: '输出内容' })
    renderChat(host, s)
    tool = host.querySelector('.tool')
    expect(host.querySelectorAll('.tool').length).toBe(1)  // 配对, 不新建
    expect(tool.querySelector('.tool-st').classList.contains('done')).toBe(true)
    const bodies = tool.querySelectorAll('.tool-sec-b')
    expect(bodies[1].textContent).toBe('输出内容')          // 结果区
  })

  it('error 工具结果把结果区标红', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_use', toolId: 'e1', toolName: 'Read' })
    applyFrame(s, { kind: 'tool_result', toolId: 'e1', content: 'ENOENT', isError: true })
    renderChat(host, s)
    const tool = host.querySelector('.tool')
    expect(tool.querySelector('.tool-st').classList.contains('error')).toBe(true)
    const bodies = tool.querySelectorAll('.tool-sec-b')
    expect(bodies[1].classList.contains('err')).toBe(true)
  })
})

describe('thinking / system / context 渲染', () => {
  it('thinking 默认折叠', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'thinking', content: '推理中' })
    renderChat(host, s)
    const body = host.querySelector('.think-b')
    expect(body.style.display).toBe('none')
    expect(body.textContent).toBe('推理中')
  })

  it('snapshot 重建后 DOM 清空旧节点(重连不残留)', () => {
    const s = createChatState()
    markUserSent(s, '旧'); applyFrame(s, { kind: 'stream_delta', content: '旧答' })
    renderChat(host, s)
    expect(host.querySelectorAll('.msg').length).toBe(2)
    applyFrame(s, { kind: 'snapshot', messages: [{ kind: 'text', role: 'user', content: '新' }] })
    renderChat(host, s)
    expect(host.querySelectorAll('.msg').length).toBe(1)
    expect(host.querySelector('.msg').textContent).toBe('新')
  })
})
