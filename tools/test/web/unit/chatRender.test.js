// @vitest-environment jsdom
// chatRender 渲染层单测 — 覆盖 §7c 的消息形态:user / assistant-md / 流式 / thinking 折叠 /
// 工具卡单行折叠展开 / 连续 ≥3 张聚拢 / system。渲染只读 state.items,状态由 reducer 构造。
import { describe, it, expect, beforeEach } from 'vitest'
import { renderChat } from '../../../../app/www/js/chatRender.js'
import { createChatState, applyFrame } from '../../../../app/www/js/normalizedChat.js'

function box() { const c = document.createElement('div'); document.body.appendChild(c); return c }
function tool(s, id, name, input, result, isError) {
  applyFrame(s, { kind: 'tool_use', toolId: id, toolName: name, toolInput: input })
  applyFrame(s, { kind: 'tool_result', toolId: id, content: result, isError: !!isError })
}

describe('user 气泡', () => {
  it('右对齐, 文本原样', () => {
    const s = createChatState(); applyFrame(s, { kind: 'text', role: 'user', content: '你好' })
    const c = box(); renderChat(c, s)
    const b = c.querySelector('.user-bubble')
    expect(b).toBeTruthy()
    expect(b.textContent).toBe('你好')
  })
})

describe('assistant markdown', () => {
  it('定稿后 mdToHtml 渲染 markdown', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'text', role: 'assistant', content: '**粗** 和 `代码`' })
    const c = box(); renderChat(c, s)
    const b = c.querySelector('.ai-bubble')
    expect(b.classList.contains('md')).toBe(true)
    expect(b.innerHTML).toContain('<strong>粗</strong>')
    expect(b.innerHTML).toContain('<code>代码</code>')
  })

  it('流式中走纯文本 + streaming 类, 不当 markdown 渲染', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'stream_delta', content: '**未定稿' })
    const c = box(); renderChat(c, s)
    const b = c.querySelector('.ai-bubble')
    expect(b.classList.contains('streaming')).toBe(true)
    expect(b.classList.contains('md')).toBe(false)
    expect(b.textContent).toBe('**未定稿')
    expect(b.querySelector('strong')).toBeNull()
  })

  it('流式定稿后同一节点转为 md(键控复用)', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'stream_delta', content: '**粗**' })
    const c = box(); renderChat(c, s)
    const before = c.querySelector('.ai-bubble')
    applyFrame(s, { kind: 'text', role: 'assistant', content: '**粗**' })
    renderChat(c, s)
    const after = c.querySelector('.ai-bubble')
    expect(after).toBe(before)   // 同一 DOM 节点复用
    expect(after.classList.contains('streaming')).toBe(false)
    expect(after.innerHTML).toContain('<strong>粗</strong>')
  })
})

describe('thinking 折叠', () => {
  it('默认折叠, 点开展开', () => {
    const s = createChatState(); applyFrame(s, { kind: 'thinking', content: '让我想想' })
    const c = box(); renderChat(c, s)
    const wrap = c.querySelector('.think')
    expect(wrap.classList.contains('open')).toBe(false)
    wrap.querySelector('.think-head').click()
    expect(wrap.classList.contains('open')).toBe(true)
    expect(wrap.querySelector('.think-body').textContent).toBe('让我想想')
  })
})

describe('工具活动卡片', () => {
  it('单行摘要: 状态图标 + 工具名 + 入参摘要(command 优先), 默认折叠', () => {
    const s = createChatState()
    tool(s, 't1', 'Bash', { command: 'ls -al', description: '列目录' }, '文件一\n文件二')
    const c = box(); renderChat(c, s)
    const card = c.querySelector('.tool-card')
    expect(card.classList.contains('ok')).toBe(true)
    expect(card.classList.contains('open')).toBe(false)
    expect(card.querySelector('.tool-name').textContent).toBe('Bash')
    expect(card.querySelector('.tool-arg').textContent).toBe('ls -al')   // command 优先于 description
    expect(card.querySelector('.tool-ic svg')).toBeTruthy()   // 完成态=线条 check 图标(W2 emoji 清零)
  })

  it('点开展开入参与结果块', () => {
    const s = createChatState()
    tool(s, 't1', 'Read', { file_path: '/a/b.txt' }, '内容')
    const c = box(); renderChat(c, s)
    const card = c.querySelector('.tool-card')
    expect(card.querySelector('.tool-arg').textContent).toBe('/a/b.txt')
    card.querySelector('.tool-head').click()
    expect(card.classList.contains('open')).toBe(true)
    const pres = card.querySelectorAll('.tool-pre')
    expect(pres[1].textContent).toBe('内容')
  })

  it('失败结果标红(err 类)', () => {
    const s = createChatState()
    tool(s, 't1', 'Bash', { command: 'boom' }, '报错了', true)
    const c = box(); renderChat(c, s)
    const card = c.querySelector('.tool-card')
    expect(card.classList.contains('error')).toBe(true)
    expect(card.querySelector('.tool-ic svg')).toBeTruthy()   // 失败态=线条 close 图标(W2 emoji 清零)
    expect(card.querySelectorAll('.tool-pre')[1].classList.contains('err')).toBe(true)
  })

  it('运行中: 无结果块, running 类', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'tool_use', toolId: 't1', toolName: 'Bash', toolInput: { command: 'sleep 1' } })
    const c = box(); renderChat(c, s)
    const card = c.querySelector('.tool-card')
    expect(card.classList.contains('running')).toBe(true)
    // 结果块隐藏
    expect(card.querySelectorAll('.tool-sec')[1].style.display).toBe('none')
  })
})

describe('连续 ≥3 张已完成工具卡聚拢', () => {
  it('3 张聚拢成一组「3 个步骤」, 组内含 3 张卡', () => {
    const s = createChatState()
    tool(s, 't1', 'Bash', { command: 'a' }, 'ra')
    tool(s, 't2', 'Bash', { command: 'b' }, 'rb')
    tool(s, 't3', 'Bash', { command: 'c' }, 'rc')
    const c = box(); renderChat(c, s)
    const groups = c.querySelectorAll(':scope > .tool-group')
    expect(groups.length).toBe(1)
    expect(c.querySelectorAll(':scope > .tool-card').length).toBe(0)
    expect(groups[0].querySelector('.tool-group-head').textContent).toBe('3 个步骤')
    expect(groups[0].querySelectorAll('.tool-group-body .tool-card').length).toBe(3)
    // 点开该组
    groups[0].querySelector('.tool-group-head').click()
    expect(groups[0].classList.contains('open')).toBe(true)
  })

  it('少于 3 张不聚拢, 各自独立', () => {
    const s = createChatState()
    tool(s, 't1', 'Bash', { command: 'a' }, 'ra')
    tool(s, 't2', 'Bash', { command: 'b' }, 'rb')
    const c = box(); renderChat(c, s)
    expect(c.querySelectorAll(':scope > .tool-group').length).toBe(0)
    expect(c.querySelectorAll(':scope > .tool-card').length).toBe(2)
  })

  it('运行中的工具卡不并入聚拢组', () => {
    const s = createChatState()
    tool(s, 't1', 'Bash', { command: 'a' }, 'ra')
    tool(s, 't2', 'Bash', { command: 'b' }, 'rb')
    applyFrame(s, { kind: 'tool_use', toolId: 't3', toolName: 'Bash', toolInput: { command: 'c' } })
    const c = box(); renderChat(c, s)
    // 两张已完成 <3 不聚拢, 加一张运行中, 共 3 张独立卡, 无组
    expect(c.querySelectorAll(':scope > .tool-group').length).toBe(0)
    expect(c.querySelectorAll(':scope > .tool-card').length).toBe(3)
  })
})

describe('system 行', () => {
  it('error 级标红', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'error', content: '出事了' })
    const c = box(); renderChat(c, s)
    const sys = c.querySelector('.msg-sys')
    expect(sys.textContent).toBe('出事了')
    expect(sys.classList.contains('err')).toBe(true)
  })

  it('中断走温和 info 行(不标红)', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'error', code: 'interrupted', message: 'user interrupted' })
    const c = box(); renderChat(c, s)
    const sys = c.querySelector('.msg-sys')
    expect(sys.textContent).toBe('（已中断）')
    expect(sys.classList.contains('err')).toBe(false)
  })
})

describe('context 注入不进消息流', () => {
  it('context item 不渲染', () => {
    const s = createChatState()
    applyFrame(s, { kind: 'context_event', summary: '注入了计划', planId: 'p1' })
    applyFrame(s, { kind: 'text', role: 'assistant', content: 'hi' })
    const c = box(); renderChat(c, s)
    expect(c.textContent).not.toContain('注入了计划')
    expect(c.querySelectorAll('.ai-bubble').length).toBe(1)
  })
})
