// @vitest-environment jsdom
// notesView UI 状态单测 — 真实驱动控制器(DOM + 拦截 fetch), 锁住:
//   · KB 卡片/详情明确只读(无编辑按钮)   · 搜索走 _search 端点
//   · 接口失败显可重试错误卡, 重试后恢复    · 创建/编辑/归档 发出正确 payload + 列表刷新
//   · markdown 渲染
// 每例 resetModules 重新 import, 隔离 notesView 的模块级状态(curSource/curQ/curNote)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DOM = `
  <div id="btnBack"></div><div id="tabbar"></div><div id="toast"></div>
  <div class="view" id="notesView">
    <div id="notesFilters"></div>
    <input id="notesQ">
    <button id="notesQBtn"></button>
    <button id="notesNew"></button>
    <div id="notesList"></div>
  </div>
  <div class="view" id="noteDetailView"><div id="noteDetail"></div></div>
`

const NOTE = { id: 'note_1', title: '我的札记', content: '札记正文', author: 'me', feedback_status: 'saved', archived: false }

function resp(body, { ok = true, status = 200, json = true } = {}) {
  return {
    ok, status,
    headers: { get: () => (json ? 'application/json' : 'text/plain') },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function defaultResponder(url, m, body) {
  if (url.includes('/api/notes/_search')) return resp({ items: [{ id: 'kb/found', title: 'KB命中', snippet: '…片段…' }], total: 1 })
  if (url.endsWith('/api/notes')) return resp({ items: [{ id: 'kb/a', title: 'KB文档', path: 'docs/kb/a.md', size: 1, mtime: 2 }], total: 1 })
  if (url.includes('/api/notes/')) return resp({ id: 'kb/a', title: 'KB文档', path: 'docs/kb/a.md', content: '# 标题\n正文段落' })
  if (url.includes('/api/boss-sight/notes/')) {
    if (m === 'DELETE') return resp({ archived: true, id: 'note_1' })
    if (m === 'PUT') return resp({ ...NOTE, content: (body && body.content) || NOTE.content })
    return resp(NOTE)
  }
  if (url.includes('/api/boss-sight/notes')) {
    if (m === 'POST') return resp({ id: 'note_new', content: (body && body.content) || '', feedback_status: 'saved' })
    return resp({ count: 1, items: [NOTE] })
  }
  return resp({ ok: true })
}

let calls, responder, notes, core
const $ = (id) => document.getElementById(id)

beforeEach(async () => {
  vi.resetModules()
  document.body.innerHTML = DOM
  calls = []
  responder = defaultResponder
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url), m = (opts.method || 'GET').toUpperCase()
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method: m, body })
    if (u.includes('/api/android/log')) return resp({ ok: true })  // 日志回传不参与断言
    return responder(u, m, body)
  }))
  core = await import('../../../../app/www/js/core.js')
  notes = await import('../../../../app/www/js/notesView.js')
  core.store.base = 'http://test'
})
afterEach(() => { vi.unstubAllGlobals() })

describe('KB 只读', () => {
  it('KB 列表卡片标注「只读」', async () => {
    await notes.loadNotes()
    const list = $('notesList')
    expect(list.querySelector('.card')).toBeTruthy()
    expect(list.textContent).toContain('只读')
  })

  it('KB 详情渲染 markdown 且无编辑/归档按钮', async () => {
    await notes.openNote('kb', 'kb/a')
    expect($('noteDetailView').classList.contains('show')).toBe(true)
    expect($('noteContent').querySelector('h1')).toBeTruthy()   // # 标题 → <h1>
    expect($('noteDetail').textContent).toContain('只读')
    expect($('noteEditBtn')).toBeNull()                         // KB 不可写
    expect($('noteDelBtn')).toBeNull()
  })
})

describe('搜索', () => {
  it('搜索框走 /api/notes/_search 端点(KB 来源)', async () => {
    notes.initNotes()
    $('notesQ').value = 'hello'
    $('notesQBtn').click()
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/api/notes/_search?q=hello'))).toBe(true))
  })
})

describe('错误重试(不静默空白)', () => {
  it('列表加载失败显示可重试错误卡, 重试后恢复', async () => {
    responder = () => resp({ detail: 'boom' }, { ok: false, status: 500 })
    await notes.loadNotes()
    expect($('notesList').textContent).toContain('加载失败')
    const btn = $('notesRetryBtn')
    expect(btn).toBeTruthy()
    responder = defaultResponder
    btn.click()
    await vi.waitFor(() => expect($('notesList').querySelector('.card')).toBeTruthy())
  })
})

describe('authored 可写: 创建 / 编辑 / 归档', () => {
  it('写札记发 POST(content + author + uses), 保存后回到列表', async () => {
    notes.openCreate()
    $('noteEditArea').value = '新札记内容'
    $('noteSaveBtn').click()
    await vi.waitFor(() => {
      const c = calls.find((c) => c.method === 'POST' && c.url.includes('/api/boss-sight/notes'))
      expect(c).toBeTruthy()
      expect(c.body.content).toBe('新札记内容')
      expect(c.body.uses).toEqual(['comment'])
    })
    await vi.waitFor(() => expect($('notesView').classList.contains('show')).toBe(true))
  })

  it('空内容不发请求并提示', async () => {
    notes.openCreate()
    $('noteEditArea').value = '   '
    $('noteSaveBtn').click()
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('authored 详情有编辑/归档按钮, 编辑保存发 PUT(content + by)', async () => {
    await notes.openNote('authored', 'note_1')
    expect($('noteEditBtn')).toBeTruthy()
    expect($('noteDelBtn')).toBeTruthy()
    $('noteEditBtn').click()              // → 编辑表单
    $('noteEditArea').value = '改后的正文'
    $('noteSaveBtn').click()
    await vi.waitFor(() => {
      const c = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/boss-sight/notes/note_1'))
      expect(c).toBeTruthy()
      expect(c.body.content).toBe('改后的正文')
      expect(c.body.by).toBeTruthy()
    })
  })

  it('归档发 DELETE(后端软删)', async () => {
    await notes.openNote('authored', 'note_1')
    $('noteDelBtn').click()
    await vi.waitFor(() => expect(
      calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/boss-sight/notes/note_1'))
    ).toBe(true))
  })
})
