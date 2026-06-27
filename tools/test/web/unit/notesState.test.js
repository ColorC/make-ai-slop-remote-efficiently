// notesState 适配层单测 — 锁住"KB 只读 / 搜索参数 / create-update payload / 卡片归一"。
// 纯函数, node 环境即可(无 DOM)。对齐已核实后端:
//   KB   GET /api/notes · GET /api/notes/_search?q=&limit= · GET /api/notes/{id:path}
//   札记 GET/POST /api/boss-sight/notes · GET/PUT/DELETE /api/boss-sight/notes/{id}
import { describe, it, expect } from 'vitest'
import {
  SOURCES, DEFAULT_SOURCE, isSource, AUTHOR,
  encPath, lastSeg, firstLine,
  kbListPath, kbSearchPath, kbNotePath,
  authoredListPath, authoredNotePath,
  listRequests, kbCard, authoredCard,
  validateContent, buildCreatePayload, buildUpdatePayload,
} from '../../../../app/www/js/notesState.js'

describe('来源筛选', () => {
  it('三个来源: kb / authored / all, 默认 kb', () => {
    expect(SOURCES.map((s) => s.value)).toEqual(['kb', 'authored', 'all'])
    expect(DEFAULT_SOURCE).toBe('kb')
  })
  it('isSource 只认已知来源', () => {
    expect(isSource('kb')).toBe(true)
    expect(isSource('all')).toBe(true)
    expect(isSource('poof')).toBe(false)
  })
})

describe('id / 文本小工具', () => {
  it('encPath 分段编码, 保留斜杠(打得到 {note_id:path} 路由)', () => {
    expect(encPath('standards/_global/foo bar')).toBe('standards/_global/foo%20bar')
    expect(encPath('a/b')).toBe('a/b')                 // 斜杠不被编码成 %2F
    expect(encPath(null)).toBe('')
  })
  it('lastSeg 取末段', () => {
    expect(lastSeg('a/b/c')).toBe('c')
    expect(lastSeg('solo')).toBe('solo')
    expect(lastSeg('a/b/')).toBe('b')
  })
  it('firstLine 取正文首行(去 markdown 标题符, 超长截断)', () => {
    expect(firstLine('# 标题\n正文')).toBe('标题')
    expect(firstLine('\n\n  正式内容  ')).toBe('正式内容')
    expect(firstLine('')).toBe('')
    expect(firstLine('x'.repeat(100)).endsWith('…')).toBe(true)
  })
})

describe('KB 路径(只读, 搜索参数锁定)', () => {
  it('列表路径固定', () => { expect(kbListPath()).toBe('/api/notes') })
  it('搜索路径带 q(编码) + limit, 默认 limit=30', () => {
    expect(kbSearchPath('hello world')).toBe('/api/notes/_search?q=hello%20world&limit=30')
    expect(kbSearchPath('a&b', 10)).toBe('/api/notes/_search?q=a%26b&limit=10')
  })
  it('详情路径分段编码', () => {
    expect(kbNotePath('plans/x y')).toBe('/api/notes/plans/x%20y')
  })
})

describe('authored 路径(可写)', () => {
  it('列表带 q / project / include_archived', () => {
    expect(authoredListPath({})).toBe('/api/boss-sight/notes')
    expect(authoredListPath({ q: 'foo' })).toBe('/api/boss-sight/notes?q=foo')
    expect(authoredListPath({ q: 'a b', project: 'p1', includeArchived: true }))
      .toBe('/api/boss-sight/notes?q=a%20b&project=p1&include_archived=true')
  })
  it('详情路径', () => {
    expect(authoredNotePath('note_abc123')).toBe('/api/boss-sight/notes/note_abc123')
  })
})

describe('listRequests —— 适配层核心(KB 只读 / 来源过滤 / 搜索端点选择)', () => {
  it('kb 无搜索词走列表端点, readOnly=true', () => {
    expect(listRequests('kb', '')).toEqual([{ src: 'kb', readOnly: true, path: '/api/notes' }])
  })
  it('kb 有搜索词走 _search 端点', () => {
    expect(listRequests('kb', 'q')).toEqual([
      { src: 'kb', readOnly: true, path: '/api/notes/_search?q=q&limit=30' },
    ])
  })
  it('authored 无搜索词, readOnly=false', () => {
    expect(listRequests('authored', '')).toEqual([
      { src: 'authored', readOnly: false, path: '/api/boss-sight/notes' },
    ])
  })
  it('authored 有搜索词带 ?q=', () => {
    expect(listRequests('authored', 'foo')[0].path).toBe('/api/boss-sight/notes?q=foo')
  })
  it('all 同时发两个请求, KB 在前且永远只读', () => {
    const reqs = listRequests('all', 'x')
    expect(reqs.map((r) => r.src)).toEqual(['kb', 'authored'])
    expect(reqs[0].readOnly).toBe(true)
    expect(reqs[1].readOnly).toBe(false)
    expect(reqs[0].path).toBe('/api/notes/_search?q=x&limit=30')
    expect(reqs[1].path).toBe('/api/boss-sight/notes?q=x')
  })
  it('KB 在任何来源下都 readOnly=true(不可写护栏)', () => {
    expect(listRequests('kb', '').every((r) => r.src !== 'kb' || r.readOnly)).toBe(true)
    expect(listRequests('all', '').filter((r) => r.src === 'kb').every((r) => r.readOnly)).toBe(true)
  })
})

describe('后端原始项 → 统一卡片', () => {
  it('KB 列表项 {id,title,path}', () => {
    expect(kbCard({ id: 'a/b', title: 'T', path: 'docs/a/b.md', size: 1, mtime: 2 }))
      .toEqual({ src: 'kb', readOnly: true, id: 'a/b', title: 'T', sub: 'docs/a/b.md' })
  })
  it('KB 搜索项 {id,title,snippet} 用 snippet 当副标题', () => {
    expect(kbCard({ id: 'a/b', title: 'T', snippet: '…命中片段…' }).sub).toBe('…命中片段…')
  })
  it('KB 无 title 回退末段, 仍只读', () => {
    const c = kbCard({ id: 'x/y/z' })
    expect(c.title).toBe('z')
    expect(c.readOnly).toBe(true)
  })
  it('authored 项可写, 状态/作者/归档透出', () => {
    const c = authoredCard({ id: 'note_1', title: 'N', content: '正文', author: 'me', feedback_status: 'delivered', archived: false })
    expect(c).toMatchObject({ src: 'authored', readOnly: false, id: 'note_1', title: 'N', status: 'delivered', author: 'me', archived: false })
  })
  it('authored 无 title 用正文首行兜底', () => {
    expect(authoredCard({ id: 'n', content: '# 想法\n细节' }).title).toBe('想法')
    expect(authoredCard({ id: 'n', content: '' }).title).toBe('(无标题札记)')
  })
})

describe('读写 payload(create / update)', () => {
  it('validateContent: 空/纯空白为假', () => {
    expect(validateContent('')).toBe(false)
    expect(validateContent('   \n ')).toBe(false)
    expect(validateContent('x')).toBe(true)
  })
  it('create: content 必填, 默认署名 + uses=[comment]', () => {
    expect(buildCreatePayload({ content: '嗨' })).toEqual({ content: '嗨', author: AUTHOR, uses: ['comment'] })
  })
  it('create: 可覆盖 author', () => {
    expect(buildCreatePayload({ content: 'x', author: 'bob' }).author).toBe('bob')
  })
  it('update: 只回传改动字段, 始终带 by(审计)', () => {
    expect(buildUpdatePayload({ content: '新正文' })).toEqual({ by: AUTHOR, content: '新正文' })
    expect(buildUpdatePayload({})).toEqual({ by: AUTHOR })             // 无改动也带 by
    expect(buildUpdatePayload({ title: 'T', content: 'C', by: 'me' }))
      .toEqual({ by: 'me', content: 'C', title: 'T' })
  })
  it('update: title 空串也回传(清自定义名, 回退正文首行)', () => {
    expect(buildUpdatePayload({ title: '' })).toEqual({ by: AUTHOR, title: '' })
  })
})
