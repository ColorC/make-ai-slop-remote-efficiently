// 笔记接口契约测试 — 用 ajv 锁定 /api/notes、/api/notes/_search、/api/boss-sight/notes
// 的列表项 / 详情 / 读写 JSON schema。样本对齐已核实后端(notes.py / authored/store.py)。
//
// 双向锁: schema 认的响应, 适配层(notesState)必须能消费产出预期卡片;
//         适配层 build 出的请求 payload, 必须通过对应 request schema。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv'
import {
  kbCard, authoredCard, buildCreatePayload, buildUpdatePayload,
} from '../../../../app/www/js/notesState.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'notes.schema.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true })
ajv.addSchema(schema)
const v = (name) => {
  const fn = ajv.getSchema('lofa://notes#/$defs/' + name)
  if (!fn) throw new Error('no such schema def: ' + name)
  return fn
}

// ── 代表性真实响应样本(对齐后端字段) ──────────────────────────────────────
const KB_LIST = { items: [{ id: 'standards/_global/foo', title: 'foo', path: 'docs/standards/_global/foo.md', size: 1234, mtime: 1.5 }], total: 1 }
const KB_SEARCH = { items: [{ id: 'plans/x', title: 'x', snippet: '…命中的上下文片段…' }], total: 1 }
const KB_DETAIL = { id: 'plans/x', title: 'x', path: 'docs/plans/x.md', content: '# 标题\n正文', mtime: 1.5, size: 99 }
const AUTHORED_NOTE = {
  id: 'note_abc123', content: '一条札记', title: '', author: 'lofa-mobile',
  target: {}, uses: ['comment'], feedback_status: 'saved', feedback_history: [],
  captures: [], project_id: 'unfiled', created_at: '2026-06-27T00:00:00+00:00',
  updated_at: '2026-06-27T00:00:00+00:00', archived: false, extra: {}, json_path: 'C:/x/note_abc123.json',
}
const AUTHORED_LIST = { count: 1, items: [AUTHORED_NOTE] }
const DELETE_RESP = { archived: true, id: 'note_abc123' }

describe('KB 只读接口 schema', () => {
  it('GET /api/notes 列表项', () => { expect(v('kbListResponse')(KB_LIST)).toBe(true) })
  it('GET /api/notes/_search 命中项含 snippet', () => { expect(v('kbSearchResponse')(KB_SEARCH)).toBe(true) })
  it('GET /api/notes/{id} 详情含 content', () => { expect(v('kbNoteDetail')(KB_DETAIL)).toBe(true) })
  it('详情缺 content 被拒', () => {
    expect(v('kbNoteDetail')({ id: 'a', title: 'a' })).toBe(false)
  })
})

describe('authored 可写接口 schema', () => {
  it('GET /api/boss-sight/notes 列表 {count, items}', () => { expect(v('authoredListResponse')(AUTHORED_LIST)).toBe(true) })
  it('单条 note 必备 id + content', () => { expect(v('authoredNote')(AUTHORED_NOTE)).toBe(true) })
  it('非法 feedback_status 被拒', () => {
    expect(v('authoredNote')({ ...AUTHORED_NOTE, feedback_status: 'bogus' })).toBe(false)
  })
  it('DELETE 软删返回 {archived, id}', () => { expect(v('deleteResponse')(DELETE_RESP)).toBe(true) })
})

describe('读写请求 payload schema(客户端 → 后端)', () => {
  it('create payload 通过 createRequest(content 必填)', () => {
    expect(v('createRequest')(buildCreatePayload({ content: '嗨' }))).toBe(true)
  })
  it('空 content 的 create payload 被拒(min_length=1)', () => {
    expect(v('createRequest')({ content: '', author: 'x', uses: ['comment'] })).toBe(false)
  })
  it('update payload 通过 updateRequest(始终带 by)', () => {
    expect(v('updateRequest')(buildUpdatePayload({ content: 'c' }))).toBe(true)
    expect(v('updateRequest')(buildUpdatePayload({ title: 't', by: 'me' }))).toBe(true)
  })
  it('update payload 缺 by 被拒', () => {
    expect(v('updateRequest')({ content: 'c' })).toBe(false)
  })
})

describe('双向锁: schema 认的响应, 适配层能消费', () => {
  it('KB 列表/搜索项 → kbCard 只读卡', () => {
    expect(v('kbListResponse')(KB_LIST)).toBe(true)
    const c = kbCard(KB_LIST.items[0])
    expect(c).toMatchObject({ src: 'kb', readOnly: true, id: 'standards/_global/foo' })
    const sc = kbCard(KB_SEARCH.items[0])
    expect(sc.sub).toBe('…命中的上下文片段…')
  })
  it('authored note → authoredCard 可写卡', () => {
    expect(v('authoredNote')(AUTHORED_NOTE)).toBe(true)
    const c = authoredCard(AUTHORED_NOTE)
    expect(c).toMatchObject({ src: 'authored', readOnly: false, id: 'note_abc123', status: 'saved', author: 'lofa-mobile' })
    expect(c.title).toBe('一条札记')   // 无 title → 正文首行兜底
  })
})
