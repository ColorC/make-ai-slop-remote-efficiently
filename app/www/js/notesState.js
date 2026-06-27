// notesState.js — 笔记 tab 的纯函数适配层(无 DOM, 可 node 单测)。
//
// 把两套后端笔记接口归一成"卡片/详情/读写请求"模型, 让 notesView 只管 DOM:
//   · KB 知识库(只读)  GET /api/notes · GET /api/notes/_search · GET /api/notes/{id:path}
//   · authored 札记(可写) GET/POST /api/boss-sight/notes · GET/PUT/DELETE /api/boss-sight/notes/{id}
//
// 设计成纯函数: 给 source/q/表单 → 路径与 payload;给后端原始项 → 统一卡片。
// 这样"KB 只读、搜索参数、create/update payload"都能被 Vitest 锁住。

// 来源筛选(对齐电脑端笔记面板能看到的范围)
export const SOURCES = [
  { value: 'kb', label: 'KB 知识库' },
  { value: 'authored', label: '我的札记' },
  { value: 'all', label: '全部' },
]
export const DEFAULT_SOURCE = 'kb'
export function isSource(v) { return SOURCES.some((s) => s.value === v) }

// authored 写入署名(create.author / update.by)
export const AUTHOR = 'lofa-mobile'

// ── 小工具 ──────────────────────────────────────────────────────────────────

// KB note id 是 docs 下的相对路径(如 standards/_global/foo);分段编码以保留斜杠,
// 否则 encodeURIComponent 会把 / 变成 %2F, 打不到 {note_id:path} 路由。
export function encPath(id) {
  return String(id == null ? '' : id).split('/').map(encodeURIComponent).join('/')
}
export function lastSeg(id) {
  const s = String(id == null ? '' : id).replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}
// authored 札记列表无 title 时, 用正文首行(去掉 markdown 标题符)兜底显示名。
export function firstLine(content) {
  const lines = String(content == null ? '' : content).split(/\r?\n/)
  for (const l of lines) {
    const t = l.replace(/^\s*#{1,6}\s*/, '').trim()
    if (t) return t.length > 80 ? t.slice(0, 80) + '…' : t
  }
  return ''
}

// ── 路径构造(搜索参数在此集中, 单测锁定) ────────────────────────────────────

export function kbListPath() { return '/api/notes' }
export function kbSearchPath(q, limit = 30) {
  return '/api/notes/_search?q=' + encodeURIComponent(q || '') + '&limit=' + (limit || 30)
}
export function kbNotePath(id) { return '/api/notes/' + encPath(id) }

export function authoredListPath(opts) {
  opts = opts || {}
  const p = []
  if (opts.q) p.push('q=' + encodeURIComponent(opts.q))
  if (opts.project) p.push('project=' + encodeURIComponent(opts.project))
  if (opts.includeArchived) p.push('include_archived=true')
  return '/api/boss-sight/notes' + (p.length ? '?' + p.join('&') : '')
}
export function authoredNotePath(id) { return '/api/boss-sight/notes/' + encodeURIComponent(id) }

// 一次列表加载要发的请求(KB 永远 readOnly;按 source 决定发哪几个)。
// 这是适配层的核心: 锁住"搜索走哪个端点 + KB 只读 + source 过滤"。
export function listRequests(source, q) {
  const reqs = []
  q = (q || '').trim()
  if (source === 'kb' || source === 'all') {
    reqs.push({ src: 'kb', readOnly: true, path: q ? kbSearchPath(q) : kbListPath() })
  }
  if (source === 'authored' || source === 'all') {
    reqs.push({ src: 'authored', readOnly: false, path: authoredListPath({ q }) })
  }
  return reqs
}

// ── 后端原始项 → 统一卡片(列表渲染消费) ─────────────────────────────────────

// KB 列表项 {id,title,path,size,mtime} 或搜索项 {id,title,snippet} 都吃。
export function kbCard(item) {
  item = item || {}
  return {
    src: 'kb',
    readOnly: true,
    id: item.id,
    title: item.title || lastSeg(item.id) || '(无标题)',
    sub: item.snippet || item.path || item.id || '',
  }
}
// authored 札记项 → 卡片(可写)。
export function authoredCard(note) {
  note = note || {}
  return {
    src: 'authored',
    readOnly: false,
    id: note.id,
    title: note.title || firstLine(note.content) || '(无标题札记)',
    sub: (note.author || 'user') + ' · ' + (note.feedback_status || 'saved'),
    status: note.feedback_status || 'saved',
    author: note.author || 'user',
    archived: !!note.archived,
  }
}

// ── 读写 payload(create/update, 单测锁定) ───────────────────────────────────

export function validateContent(content) {
  return String(content == null ? '' : content).trim().length > 0
}

// POST /api/boss-sight/notes —— content 必填(后端 min_length=1)。
export function buildCreatePayload(opts) {
  opts = opts || {}
  return {
    content: String(opts.content == null ? '' : opts.content),
    author: opts.author || AUTHOR,
    uses: ['comment'],
  }
}

// PUT /api/boss-sight/notes/{id} —— 只回传改动的字段, 始终带 by(审计)。
export function buildUpdatePayload(opts) {
  opts = opts || {}
  const body = { by: opts.by || AUTHOR }
  if (opts.content != null) body.content = String(opts.content)
  if (opts.title != null) body.title = String(opts.title)
  return body
}
