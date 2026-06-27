// 审阅补齐接口契约测试(M4) — 用 ajv 锁定 /api/boss-sight/reviewstage 的:
//   列表项 / _stats 角标 / material(含 custom_web_template + 批注 target) /
//   batch_verdict · batch_delete 请求与响应 / comment 请求体 / WS /stream 事件 schema。
// 样本对齐真后端: store.py(Material/Comment/Annotation.to_dict) + routes.py(batch 响应 / WS 帧)
// + reviewstageClient.ts(电脑端真实字段)。评论/批注用 content+author+target(无 text/body/by/anchor)。
// 双向锁: schema 认的响应/请求, 适配层(reviewState)必须能消费或产出对应结构。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv'
import {
  statsBadges, extractAnnotations, imageAnnotations, markdownAnnotations, plainComments,
  templateFallbackCard, buildBatchVerdictPayload, buildBatchDeletePayload, buildCommentPayload,
  isReviewEvent, reviewEventId, imageAnchorToScreen, buildMarkdownLines, parseKeyQuestion,
  summarizeBatch,
} from '../../../../app/www/js/reviewState.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'review.schema.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true, strictTypes: false })
ajv.addSchema(schema)
const v = (name) => {
  const fn = ajv.getSchema('lofa://review#/$defs/' + name)
  if (!fn) throw new Error('no such schema def: ' + name)
  return fn
}

// ── 代表性真实响应/请求样本(对齐后端字段) ──────────────────────────────────
const LIST = {
  count: 2,
  items: [
    { id: 'm1', kind: 'markdown', tier: 'mandatory', status: 'pending', title: '设计稿', source_plan_id: 'lofa/[2026-06-27]X',
      updated_at: '2026-06-27T08:00:00+00:00', pushed_to_user: true },
    { id: 'm2', kind: 'image', tier: 'important', status: 'accepted', title: '截图', archived: true },
  ],
  filter: { status: 'pending', tier: null, plan_id: null, pushed_only: false },
}
const STATS = { total: 9, by_status: { pending: 3, accepted: 4, rejected: 1, blocked: 1 }, by_tier: { mandatory: 2 }, mandatory_unaccepted: 2, pushed_unread: 5 }
// markdown: 行批注 target={line_start,line_end}; 普通评论 target={}。content/author 真字段。
const MD_MATERIAL = {
  id: 'm1', kind: 'markdown', tier: 'mandatory', status: 'pending', title: '设计稿', inline_content: 'a\nb\nc',
  annotations: [],
  comments: [
    { id: 'cmt_1', author: 'grace', content: '第二行改一下', created_at: '2026-06-27T09:00:00+00:00', target: { line_start: 2, line_end: 2 } },
    { id: 'cmt_2', author: 'grace', content: '整体 OK', target: {} },
  ],
}
// image: AI 批注在 annotations[], target={x,y} 点 / {x,y,w,h} 框(无 type)。
const IMG_MATERIAL = {
  id: 'm2', kind: 'image', tier: 'important', status: 'pending', title: '截图',
  annotations: [
    { id: 'ann_3', author: 'controller', kind: 'ai', content: '这个按钮', target: { x: 0.5, y: 0.4 } },
    { id: 'ann_4', author: 'controller', kind: 'ai', content: '这块区域', target: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } },
  ],
  comments: [],
}
const TPL_MATERIAL = {
  id: 'm3', kind: 'custom_web_template', tier: 'processual', status: 'pending', title: 'Diff 报告',
  extra: { template: 'filetree_diff', description: '改了 3 个文件', live_url: '/live/m3', files: ['a.ts', 'b.ts'] },
}
// key_question: inline_content 是 JSON 字符串(后端 /file 返回 application/json)。
const KQ_MATERIAL = {
  id: 'm4', kind: 'key_question', tier: 'mandatory', status: 'pending', title: '该用哪个方案',
  inline_content: JSON.stringify({ question: '选 A 还是 B?', options: ['方案 A', '方案 B'], explanation: 'A 更稳' }),
}
// batch 响应真实键
const BATCH_VERDICT_RESP = { ok: true, changed_count: 1, changed_ids: ['m1'], not_found: ['mX'], skipped: [{ id: 'm2', error: '已锁定' }] }
const BATCH_DELETE_RESP = { ok: true, deleted_count: 2, deleted_ids: ['m1', 'm2'], skipped_pending: 1, not_found: [] }

describe('/api/boss-sight/reviewstage 列表 schema', () => {
  it('整体 {count, items, filter}', () => { expect(v('listResponse')(LIST)).toBe(true) })
  it('列表项必备 id+kind+tier+status', () => { expect(v('listItem')(LIST.items[0])).toBe(true) })
  it('缺 status 被拒', () => { expect(v('listItem')({ id: 'x', kind: 'image', tier: 'important' })).toBe(false) })
  it('非法 status 被拒', () => { expect(v('listItem')({ id: 'x', kind: 'image', tier: 'important', status: 'weird' })).toBe(false) })
})

describe('/_stats 角标 schema', () => {
  it('必备 mandatory_unaccepted + pushed_unread', () => { expect(v('stats')(STATS)).toBe(true) })
  it('缺 pushed_unread 被拒', () => { expect(v('stats')({ mandatory_unaccepted: 1 })).toBe(false) })
})

describe('material schema(评论/批注 content+author+target)', () => {
  it('markdown material + 行批注(target.line_start)', () => { expect(v('material')(MD_MATERIAL)).toBe(true) })
  it('image material + 点/框批注(target.x/y[/w/h])', () => { expect(v('material')(IMG_MATERIAL)).toBe(true) })
  it('key_question material(inline_content 是 JSON 字符串)', () => { expect(v('material')(KQ_MATERIAL)).toBe(true) })
  it('custom_web_template 专项 schema(extra.template/live_url)', () => {
    expect(v('customWebTemplateMaterial')(TPL_MATERIAL)).toBe(true)
  })
  it('评论缺 content 被拒(后端必填)', () => {
    expect(v('comment')({ author: 'grace', target: {} })).toBe(false)
  })
})

describe('请求体 schema(batch_verdict / batch_delete / comment)', () => {
  it('batch_verdict 必备 ids+verdict+by', () => {
    expect(v('batchVerdictRequest')(buildBatchVerdictPayload(['m1', 'm2'], 'accepted'))).toBe(true)
  })
  it('batch_verdict 空 ids 被拒(minItems)', () => {
    expect(v('batchVerdictRequest')({ ids: [], verdict: 'accepted', by: 'x' })).toBe(false)
  })
  it('batch_verdict 非法 verdict 被拒', () => {
    expect(v('batchVerdictRequest')({ ids: ['a'], verdict: 'maybe', by: 'x' })).toBe(false)
  })
  it('batch_delete 必备 ids+by', () => {
    expect(v('batchDeleteRequest')(buildBatchDeletePayload(['m1']))).toBe(true)
  })
  it('comment 必备 content+by; 带 target 合法', () => {
    expect(v('commentRequest')(buildCommentPayload('看这'))).toBe(true)
    expect(v('commentRequest')(buildCommentPayload('看这点', { anchor: { type: 'point', x: 0.5, y: 0.5 } }))).toBe(true)
  })
  it('comment 发 {text,by} 旧形态被拒(后端会 422)', () => {
    expect(v('commentRequest')({ text: '看这', by: 'x' })).toBe(false)
  })
})

describe('batch 响应 schema(真后端键)', () => {
  it('batch_verdict 响应 {changed_count,changed_ids,not_found,skipped}', () => {
    expect(v('batchVerdictResponse')(BATCH_VERDICT_RESP)).toBe(true)
  })
  it('batch_delete 响应 {deleted_count,deleted_ids,skipped_pending,not_found}', () => {
    expect(v('batchDeleteResponse')(BATCH_DELETE_RESP)).toBe(true)
  })
})

describe('WS /stream 事件 schema({event_type, material} 嵌套)', () => {
  it('真集事件合法', () => {
    ['created', 'updated', 'verdict_changed', 'comment_added', 'annotation_added', 'pushed', 'deleted'].forEach((t) => {
      expect(v('streamEvent')({ event_type: t, material: MD_MATERIAL })).toBe(true)
    })
  })
  it('已废弃的 archived 被拒(归档走 updated)', () => { expect(v('streamEvent')({ event_type: 'archived' })).toBe(false) })
  it('未知事件被拒', () => { expect(v('streamEvent')({ event_type: 'noise' })).toBe(false) })
})

describe('双向锁: schema 认的响应/请求, 适配层能消费/产出', () => {
  it('_stats → statsBadges 映射出 mandatory_unaccepted=2 / pushed_unread=5', () => {
    expect(v('stats')(STATS)).toBe(true)
    const b = statsBadges(STATS)
    expect(b.find((x) => x.key === 'mandatory_unaccepted').count).toBe(2)
    expect(b.find((x) => x.key === 'pushed_unread').count).toBe(5)
  })
  it('markdown material → 行批注分桶(target.line_start) + 行号定位命中第 2 行', () => {
    expect(v('material')(MD_MATERIAL)).toBe(true)
    expect(plainComments(MD_MATERIAL).map((a) => a.id)).toEqual(['cmt_2'])
    const annos = markdownAnnotations(MD_MATERIAL)
    expect(annos.map((a) => a.id)).toEqual(['cmt_1'])
    const rows = buildMarkdownLines(MD_MATERIAL.inline_content, annos)
    expect(rows[1]).toMatchObject({ n: 2, annotated: true })
  })
  it('image material → 点/框分桶(target.x/y[/w/h]) + 坐标归一化到 200x100 屏幕', () => {
    expect(v('material')(IMG_MATERIAL)).toBe(true)
    const imgs = imageAnnotations(IMG_MATERIAL)
    expect(imgs.map((a) => a.anchor.type)).toEqual(['point', 'rect'])
    expect(imageAnchorToScreen(imgs[0].anchor, { width: 200, height: 100 })).toEqual({ type: 'point', left: 100, top: 40 })
  })
  it('key_question material → 解析出 问题/选项/说明', () => {
    expect(v('material')(KQ_MATERIAL)).toBe(true)
    const kq = parseKeyQuestion(KQ_MATERIAL.inline_content)
    expect(kq).toMatchObject({ ok: true, question: '选 A 还是 B?', options: ['方案 A', '方案 B'], explanation: 'A 更稳' })
  })
  it('custom_web_template → 兜底卡(标题/模板/说明/字段/链接)', () => {
    expect(v('customWebTemplateMaterial')(TPL_MATERIAL)).toBe(true)
    const card = templateFallbackCard(TPL_MATERIAL, 'http://h')
    expect(card).toMatchObject({ title: 'Diff 报告', template: 'filetree_diff', description: '改了 3 个文件', url: 'http://h/live/m3' })
    expect(card.fields.map((f) => f.key)).toEqual(['files'])
  })
  it('comment 请求体 → 产出 content+author(+target), schema 通过', () => {
    const p = buildCommentPayload('看这点', { anchor: { type: 'point', x: 0.5, y: 0.5 } })
    expect(p).toEqual({ content: '看这点', author: 'lofa-mobile', target: { x: 0.5, y: 0.5 } })
    expect(v('commentRequest')(p)).toBe(true)
  })
  it('batch_verdict 响应 → summarizeBatch 读 changed_count/not_found/skipped', () => {
    expect(v('batchVerdictResponse')(BATCH_VERDICT_RESP)).toBe(true)
    const s = summarizeBatch(BATCH_VERDICT_RESP, ['m1', 'm2', 'mX'])
    expect(s.ok).toBe(1)
    expect(s.failed).toEqual([{ id: 'mX', error: '未找到' }, { id: 'm2', error: '已锁定' }])
  })
  it('batch_delete 响应 → summarizeBatch 读 deleted_count/skipped_pending', () => {
    expect(v('batchDeleteResponse')(BATCH_DELETE_RESP)).toBe(true)
    const s = summarizeBatch(BATCH_DELETE_RESP, ['m1', 'm2', 'm3'])
    expect(s.ok).toBe(2)
    expect(s.skippedPending).toBe(1)
  })
  it('WS 事件 → 适配层判别 + 取 id(material 嵌套)', () => {
    const ev = { event_type: 'verdict_changed', material: { id: 'm1', kind: 'markdown', tier: 'important', status: 'accepted' } }
    expect(v('streamEvent')(ev)).toBe(true)
    expect(isReviewEvent(ev)).toBe(true)
    expect(reviewEventId(ev)).toBe('m1')
  })
})
