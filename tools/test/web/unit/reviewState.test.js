// reviewState 适配层单测(M4) — 锁住电脑端审阅台动作集与 material 覆盖的纯逻辑:
//   · 多选 reducer  · batch_verdict/batch_delete payload  · include_archived 列表参数
//   · _stats 角标映射  · 图片归一化坐标→屏幕坐标  · markdown 行号定位
//   · custom_web_template 兜底卡  · 批注/锚点归一  · WS 回流事件判别
// 纯函数, node 环境即可(无 DOM)。对齐已核实后端 base /api/boss-sight/reviewstage。
import { describe, it, expect } from 'vitest'
import {
  BASE_PATH, BY, VERDICT_REASON, FILTERS, DEFAULT_FILTER, VERDICTS, verdictDone,
  listQuery, listPath, detailPath, filePath, statsPath, verdictPath, commentPath,
  archivePath, markPushedPath, batchVerdictPath, batchDeletePath, streamWsUrl,
  SELECTION_INIT, selectionReducer, selHas, selCount, selIds,
  buildVerdictPayload, buildBatchVerdictPayload, buildBatchDeletePayload, buildCommentPayload, buildArchivePayload,
  summarizeBatch, statsBadges, cardFlags,
  isWebKind, isWebMaterial, looksLikeHtmlDoc, isImageKind, isVideoKind, isKeyQuestionKind,
  templateName, resolveWebUrl, templateFallbackCard,
  normAnchor, anchorToTarget, normAnnotation, extractAnnotations, imageAnnotations, markdownAnnotations, plainComments,
  clamp01, clampPositiveInt, imageAnchorToScreen, clampLine, buildMarkdownLines, firstAnnotatedLine,
  isReviewEvent, reviewEventType, reviewEventId, REVIEW_EVENTS, parseKeyQuestion,
} from '../../../../app/www/js/reviewState.js'

describe('筛选/审判常量', () => {
  it('状态筛选含 全部, 默认 pending', () => {
    expect(FILTERS.map((f) => f[0])).toEqual(['pending', 'accepted', 'rejected', 'blocked', ''])
    expect(DEFAULT_FILTER).toBe('pending')
  })
  it('审判动作三态 + 完成文案', () => {
    expect(VERDICTS.map((v) => v.value)).toEqual(['accepted', 'rejected', 'blocked'])
    expect(verdictDone('accepted')).toBe('已通过')
    expect(verdictDone('blocked')).toBe('已阻断')
    expect(verdictDone('weird')).toBe('已记录')
  })
})

describe('列表查询(include_archived 默认不带, 切换才带)', () => {
  it('默认: 只有 limit + status, 无 include_archived', () => {
    expect(listQuery({ status: 'pending' })).toBe('limit=100&status=pending')
    expect(listQuery({ status: 'pending' })).not.toContain('include_archived')
  })
  it('全部(status 空)不带 status', () => {
    expect(listQuery({ status: '' })).toBe('limit=100')
  })
  it('include_archived=true → 带 include_archived=1', () => {
    expect(listQuery({ status: 'pending', include_archived: true })).toBe('limit=100&status=pending&include_archived=1')
  })
  it('tier / plan_id / pushed_only / limit 透传', () => {
    expect(listQuery({ tier: 'mandatory', plan_id: 'a/b', pushed_only: true, limit: 50 }))
      .toBe('limit=50&tier=mandatory&plan_id=a%2Fb&pushed_only=1')
  })
  it('listPath 拼到 base', () => {
    expect(listPath({ status: 'pending' })).toBe('/api/boss-sight/reviewstage?limit=100&status=pending')
  })
})

describe('路径工具', () => {
  it('详情/正文/角标/审判/评论/归档/标已读/批量/WS', () => {
    expect(detailPath('m1')).toBe(BASE_PATH + '/m1')
    expect(filePath('m1')).toBe(BASE_PATH + '/m1/file')
    expect(statsPath()).toBe(BASE_PATH + '/_stats')
    expect(verdictPath('m1')).toBe(BASE_PATH + '/m1/verdict')
    expect(commentPath('m1')).toBe(BASE_PATH + '/m1/comment')
    expect(archivePath('m1')).toBe(BASE_PATH + '/m1/archive')
    expect(markPushedPath('m1')).toBe(BASE_PATH + '/m1/mark_pushed')
    expect(batchVerdictPath()).toBe(BASE_PATH + '/batch_verdict')
    expect(batchDeletePath()).toBe(BASE_PATH + '/batch_delete')
  })
  it('id 编码(含特殊字符)', () => {
    expect(detailPath('a/b c')).toBe(BASE_PATH + '/a%2Fb%20c')
  })
  it('streamWsUrl: http→ws / https→wss', () => {
    expect(streamWsUrl('http://10.0.0.1:8210')).toBe('ws://10.0.0.1:8210' + BASE_PATH + '/stream')
    expect(streamWsUrl('https://host')).toBe('wss://host' + BASE_PATH + '/stream')
  })
})

describe('多选 reducer', () => {
  it('enter 进多选态, exit 退出并清空', () => {
    let s = selectionReducer(SELECTION_INIT, { type: 'enter' })
    expect(s).toEqual({ mode: true, ids: [] })
    s = selectionReducer({ mode: true, ids: ['a'] }, { type: 'exit' })
    expect(s).toEqual({ mode: false, ids: [] })
  })
  it('toggle 选中/取消, 保序去重', () => {
    let s = selectionReducer(SELECTION_INIT, { type: 'toggle', id: 'a' })
    expect(s.ids).toEqual(['a'])
    s = selectionReducer(s, { type: 'toggle', id: 'b' })
    expect(s.ids).toEqual(['a', 'b'])
    s = selectionReducer(s, { type: 'toggle', id: 'a' })   // 取消 a
    expect(s.ids).toEqual(['b'])
  })
  it('set on/off 幂等', () => {
    let s = selectionReducer(SELECTION_INIT, { type: 'set', id: 'a', on: true })
    s = selectionReducer(s, { type: 'set', id: 'a', on: true })   // 再 on 不重复
    expect(s.ids).toEqual(['a'])
    s = selectionReducer(s, { type: 'set', id: 'a', on: false })
    expect(s.ids).toEqual([])
  })
  it('selectAll 去重; clear 清空但保留 mode', () => {
    let s = selectionReducer(SELECTION_INIT, { type: 'selectAll', ids: ['a', 'b', 'a'] })
    expect(s).toEqual({ mode: true, ids: ['a', 'b'] })
    s = selectionReducer(s, { type: 'clear' })
    expect(s).toEqual({ mode: true, ids: [] })
  })
  it('选择器 selHas / selCount / selIds', () => {
    const s = { mode: true, ids: ['a', 'b'] }
    expect(selHas(s, 'a')).toBe(true)
    expect(selHas(s, 'z')).toBe(false)
    expect(selCount(s)).toBe(2)
    expect(selIds(s)).toEqual(['a', 'b'])
    expect(selIds(s)).not.toBe(s.ids)   // 拷贝, 不泄露内部引用
  })
})

describe('单/批量 审判·删除·评论 payload', () => {
  it('单审判默认 by/reason', () => {
    expect(buildVerdictPayload('accepted')).toEqual({ verdict: 'accepted', by: BY, reason: VERDICT_REASON })
  })
  it('batch_verdict: ids 去重 + verdict + by + reason', () => {
    expect(buildBatchVerdictPayload(['a', 'b', 'a'], 'rejected'))
      .toEqual({ ids: ['a', 'b'], verdict: 'rejected', by: BY, reason: VERDICT_REASON })
  })
  it('batch_delete: ids 去重 + by; 带 reason 才加', () => {
    expect(buildBatchDeletePayload(['a', 'a', 'c'])).toEqual({ ids: ['a', 'c'], by: BY })
    expect(buildBatchDeletePayload(['a'], { reason: '清理' })).toEqual({ ids: ['a'], by: BY, reason: '清理' })
  })
  it('comment: 后端真字段 content+author; 锚点进 target(不发 text/by/anchor)', () => {
    expect(buildCommentPayload('看这里')).toEqual({ content: '看这里', author: BY })
    // 图片点锚点 → target {x,y}(后端 image target 形态, 无 type)
    expect(buildCommentPayload('看这点', { anchor: { type: 'point', x: 0.5, y: 0.5 } }))
      .toEqual({ content: '看这点', author: BY, target: { x: 0.5, y: 0.5 } })
    // markdown 行锚点 → target {line_start,line_end}
    expect(buildCommentPayload('改这行', { anchor: { type: 'line', line: 3, lineEnd: 5 } }))
      .toEqual({ content: '改这行', author: BY, target: { line_start: 3, line_end: 5 } })
    // 直接给 target 也透传
    expect(buildCommentPayload('框', { target: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }))
      .toEqual({ content: '框', author: BY, target: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })
  })
  it('anchorToTarget: 本端 anchor → 后端 target 形态', () => {
    expect(anchorToTarget({ type: 'point', x: 0.5, y: 0.4 })).toEqual({ x: 0.5, y: 0.4 })
    expect(anchorToTarget({ type: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.2 })).toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 })
    expect(anchorToTarget({ type: 'line', line: 2, lineEnd: 4 })).toEqual({ line_start: 2, line_end: 4 })
    expect(anchorToTarget(null)).toEqual({})
  })
  it('archive payload', () => {
    expect(buildArchivePayload(true)).toEqual({ archived: true, by: BY })
  })
})

describe('批量局部失败/跳过归一(读真后端 routes.py 键)', () => {
  it('batch_verdict 响应: changed_count + not_found + skipped[{id,error}]', () => {
    const r = summarizeBatch(
      { ok: true, changed_count: 1, changed_ids: ['a'], not_found: ['z'], skipped: [{ id: 'b', error: '已锁定' }] },
      ['a', 'b', 'z'],
    )
    expect(r).toEqual({ total: 3, ok: 1, failed: [{ id: 'z', error: '未找到' }, { id: 'b', error: '已锁定' }], skippedPending: 0 })
  })
  it('batch_delete 响应: deleted_count + skipped_pending(计数) + not_found', () => {
    const r = summarizeBatch(
      { ok: true, deleted_count: 2, deleted_ids: ['a', 'b'], skipped_pending: 1, not_found: ['z'] },
      ['a', 'b', 'c', 'z'],
    )
    expect(r).toMatchObject({ total: 4, ok: 2, skippedPending: 1, failed: [{ id: 'z', error: '未找到' }] })
  })
  it('全成功(无 not_found / skipped)', () => {
    expect(summarizeBatch({ changed_count: 2, changed_ids: ['a', 'b'], not_found: [], skipped: [] }, ['a', 'b']))
      .toEqual({ total: 2, ok: 2, failed: [], skippedPending: 0 })
  })
  it('空响应兜底: ok = total - 失败 - 跳过', () => {
    expect(summarizeBatch({}, ['a', 'b'])).toEqual({ total: 2, ok: 2, failed: [], skippedPending: 0 })
  })
})

describe('_stats 角标映射(至少 mandatory_unaccepted / pushed_unread)', () => {
  it('从 {by_status, mandatory_unaccepted, pushed_unread} 映射计数', () => {
    const b = statsBadges({ by_status: { pending: 3 }, mandatory_unaccepted: 2, pushed_unread: 5 })
    expect(b).toEqual([
      { key: 'pending', label: '待审', count: 3 },
      { key: 'mandatory_unaccepted', label: '强制未过', count: 2 },
      { key: 'pushed_unread', label: '新推送', count: 5 },
    ])
  })
  it('缺字段补 0; 字符串数字也吃', () => {
    const b = statsBadges({ pushed_unread: '4' })
    expect(b.find((x) => x.key === 'pending').count).toBe(0)
    expect(b.find((x) => x.key === 'mandatory_unaccepted').count).toBe(0)
    expect(b.find((x) => x.key === 'pushed_unread').count).toBe(4)
  })
  it('空入参不崩', () => { expect(statsBadges(null).length).toBe(3) })
})

describe('卡片角标 cardFlags(后端真字段 pushed_to_user + status)', () => {
  it('pushed_to_user && pending → 未读; mandatory tier; archived', () => {
    expect(cardFlags({ pushed_to_user: true, status: 'pending', tier: 'mandatory', archived: true }))
      .toEqual({ pushedUnread: true, mandatory: true, archived: true })
    // 已推送但非 pending(已审阅过)→ 不算未读
    expect(cardFlags({ pushed_to_user: true, status: 'accepted' })).toMatchObject({ pushedUnread: false })
    expect(cardFlags({ tier: 'processual' })).toMatchObject({ mandatory: false, pushedUnread: false })
  })
})

describe('material kind 判别 + custom_web_template 兜底', () => {
  it('网页类与后端/桌面端一致: html / custom_web_template / static-report / demo', () => {
    expect(isWebKind('html')).toBe(true)
    expect(isWebKind('custom_web_template')).toBe(true)
    expect(isWebKind('static-report')).toBe(true)
    expect(isWebKind('demo')).toBe(true)
    expect(isWebKind('live_url')).toBe(false)   // 后端 MaterialKind 枚举无此 kind
    expect(isWebKind('image')).toBe(false)
    expect(isImageKind('image')).toBe(true)
    expect(isImageKind('aigc-image')).toBe(true)
    expect(isVideoKind('video')).toBe(true)
    expect(isKeyQuestionKind('key_question')).toBe(true)
    expect(isKeyQuestionKind('markdown')).toBe(false)
  })
  it('extra.live_url 与完整 HTML 正文可识别为网页材料', () => {
    expect(isWebMaterial({ kind: 'legacy', extra: { live_url: '/live/x' } })).toBe(true)
    expect(isWebMaterial({ kind: 'legacy', content_type: 'text/html; charset=utf-8' })).toBe(true)
    expect(isWebMaterial({ kind: 'legacy', mime_type: 'application/xhtml+xml' })).toBe(true)
    expect(isWebMaterial({ kind: 'legacy', file_relpath: 'reports/demo.html?rev=2' })).toBe(true)
    expect(isWebMaterial({ kind: 'markdown', extra: {} })).toBe(false)
    expect(looksLikeHtmlDoc('<!doctype html><html></html>')).toBe(true)
    expect(looksLikeHtmlDoc('  <body>legacy</body>')).toBe(true)
    expect(looksLikeHtmlDoc('# Markdown')).toBe(false)
  })
  it('templateName 从 template / extra.template / extra.template_name 取', () => {
    expect(templateName({ extra: { template: 'filetree_diff' } })).toBe('filetree_diff')
    expect(templateName({ template: 'x' })).toBe('x')
    expect(templateName({ extra: {} })).toBe('')
  })
  it('resolveWebUrl: live_url(/ 同源拼 base)优先, 否则 /file', () => {
    expect(resolveWebUrl({ id: 'm1', extra: { live_url: '/live/x' } }, 'http://h')).toBe('http://h/live/x')
    expect(resolveWebUrl({ id: 'm1', extra: { live_url: 'http://ext/y' } }, 'http://h')).toBe('http://ext/y')
    expect(resolveWebUrl({ id: 'm1', extra: {} }, 'http://h')).toBe('http://h/api/boss-sight/reviewstage/m1/file')
  })
  it('resolveWebUrl:同主机旧 8210/http 地址归一到当前正式网关', () => {
    const m = { id: 'm1', extra: { live_url: 'http://10.3.43.246:8210/report/x.html?q=1' } }
    expect(resolveWebUrl(m, 'https://10.3.43.246:12443'))
      .toBe('https://10.3.43.246:12443/report/x.html?q=1')
  })
  it('templateFallbackCard: 标题/模板/说明/原始字段/链接, 跳过已知键, 空白也不崩', () => {
    const card = templateFallbackCard({
      id: 'm1', title: 'Diff 报告', summary: '兜底说明',
      extra: { template: 'filetree_diff', description: '改了 3 个文件', files: ['a.ts', 'b.ts'], live_url: '/live/m1' },
    }, 'http://h')
    expect(card.title).toBe('Diff 报告')
    expect(card.template).toBe('filetree_diff')
    expect(card.description).toBe('改了 3 个文件')
    expect(card.url).toBe('http://h/live/m1')
    expect(card.hasLiveUrl).toBe(true)
    // 原始字段保留 files(对象/数组 JSON 化), 跳过 template/description/live_url
    expect(card.fields.map((f) => f.key)).toEqual(['files'])
    expect(card.fields[0].value).toBe('["a.ts","b.ts"]')
  })
  it('空模板也给标题与 /file 链接(不空白)', () => {
    const card = templateFallbackCard({ id: 'm9' }, 'http://h')
    expect(card.title).toBe('(无标题)')
    expect(card.url).toBe('http://h/api/boss-sight/reviewstage/m9/file')
    expect(card.fields).toEqual([])
  })
})

describe('批注/锚点归一(读后端 target, 据字段推断类型, 无 type 字段)', () => {
  it('normAnchor: 图片 {x,y}→点 / {x,y,w,h}→框(归一化 0..1)', () => {
    expect(normAnchor({ x: 0.5, y: 0.3 })).toEqual({ type: 'point', x: 0.5, y: 0.3 })
    // 有 w/h(>0) → 框; 越界被 clamp
    expect(normAnchor({ x: 1.5, y: -0.2, w: 0.4, h: 0.4 }))
      .toEqual({ type: 'rect', x: 1, y: 0, w: 0.4, h: 0.4 })
    // w/h 为 0 → 当点(非框)
    expect(normAnchor({ x: 0.2, y: 0.2, w: 0, h: 0 })).toEqual({ type: 'point', x: 0.2, y: 0.2 })
  })
  it('normAnchor: markdown {line_start,line_end}→line(1-based)', () => {
    expect(normAnchor({ line_start: 12, line_end: 12 })).toEqual({ type: 'line', line: 12, lineEnd: 12 })
    expect(normAnchor({ line_start: 5, line_end: 9 })).toEqual({ type: 'line', line: 5, lineEnd: 9 })
    // 只有 line_start
    expect(normAnchor({ line_start: 3 })).toEqual({ type: 'line', line: 3, lineEnd: 3 })
  })
  it('normAnchor: 无定位字段(html selector / 空)→ null', () => {
    expect(normAnchor(null)).toBe(null)
    expect(normAnchor({})).toBe(null)
    expect(normAnchor({ selector: '.btn' })).toBe(null)        // html 选择器本端不定位
    expect(normAnchor({ question_index: 0 })).toBe(null)       // key_question 本端不定位
  })
  it('normAnnotation: 读 content(正文)+ author(作者)+ target(定位)', () => {
    expect(normAnnotation({ id: 'cmt_1', author: 'grace', content: '看这里', created_at: 't', target: { line_start: 3, line_end: 3 } }))
      .toMatchObject({ id: 'cmt_1', by: 'grace', text: '看这里', at: 't', anchor: { type: 'line', line: 3 } })
    expect(normAnnotation({ author: 'a', content: 'x' })).toMatchObject({ by: 'a', text: 'x', anchor: null })
  })
  it('extract/image/markdown/plain 分桶(target 形态)', () => {
    const m = {
      annotations: [
        { id: 1, content: '图上点', author: 'controller', target: { x: 0.2, y: 0.2 } },
        { id: 2, content: '图上框', author: 'controller', target: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } },
      ],
      comments: [
        { id: 3, content: '行批注', author: 'grace', target: { line_start: 4, line_end: 4 } },
        { id: 4, content: '普通评论', author: 'grace', target: {} },
      ],
    }
    expect(extractAnnotations(m)).toHaveLength(4)
    expect(imageAnnotations(m).map((a) => a.id)).toEqual([1, 2])
    expect(markdownAnnotations(m).map((a) => a.id)).toEqual([3])
    expect(plainComments(m).map((a) => a.id)).toEqual([4])
  })
  it('合并 annotations + comments 两路(批注在前)', () => {
    const out = extractAnnotations({ annotations: [{ id: 9, content: 'a', author: 'c' }], comments: [{ id: 1, content: 'b', author: 'u' }] })
    expect(out.map((a) => a.id)).toEqual([9, 1])
    expect(extractAnnotations({})).toEqual([])
  })
})

describe('key_question 解析(inline_content 是 JSON)', () => {
  it('解析出 question / options[] / explanation', () => {
    const json = JSON.stringify({ question: '选 A 还是 B?', options: ['方案 A', '方案 B'], explanation: 'A 更稳' })
    expect(parseKeyQuestion(json)).toEqual({ ok: true, question: '选 A 还是 B?', options: ['方案 A', '方案 B'], explanation: 'A 更稳', raw: json })
  })
  it('无 options / explanation 也不崩', () => {
    const kq = parseKeyQuestion(JSON.stringify({ question: '只有问题' }))
    expect(kq).toMatchObject({ ok: true, question: '只有问题', options: [], explanation: '' })
  })
  it('非 JSON → ok:false 退原始文本(别当 markdown 显原始)', () => {
    expect(parseKeyQuestion('not json')).toEqual({ ok: false, raw: 'not json' })
    expect(parseKeyQuestion('')).toEqual({ ok: false, raw: '' })
    expect(parseKeyQuestion(null)).toEqual({ ok: false, raw: '' })
  })
})

describe('图片归一化坐标 → 屏幕坐标', () => {
  it('point: (0.5,0.5) on 200x100 → (100,50)', () => {
    expect(imageAnchorToScreen({ type: 'point', x: 0.5, y: 0.5 }, { width: 200, height: 100 }))
      .toEqual({ type: 'point', left: 100, top: 50 })
  })
  it('rect: 归一化框 → 像素框', () => {
    expect(imageAnchorToScreen({ type: 'rect', x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, { width: 200, height: 100 }))
      .toEqual({ type: 'rect', left: 20, top: 20, width: 100, height: 25 })
  })
  it('越界坐标先 clamp 再换算', () => {
    expect(imageAnchorToScreen({ type: 'point', x: 2, y: -1 }, { width: 200, height: 100 }))
      .toEqual({ type: 'point', left: 200, top: 0 })
  })
  it('clamp01 边界', () => {
    expect(clamp01(-1)).toBe(0); expect(clamp01(2)).toBe(1); expect(clamp01(0.4)).toBe(0.4)
    expect(clamp01('x')).toBe(0)
  })
})

describe('markdown 行号定位', () => {
  const content = 'line1\nline2\nline3\nline4\nline5'
  it('buildMarkdownLines: 标注命中行, 透出批注', () => {
    const annos = markdownAnnotations({ comments: [{ id: 1, content: '改这', author: 'g', target: { line_start: 3, line_end: 3 } }] })
    const rows = buildMarkdownLines(content, annos)
    expect(rows).toHaveLength(5)
    expect(rows[2]).toMatchObject({ n: 3, annotated: true })
    expect(rows[2].notes[0].text).toBe('改这')
    expect(rows[0].annotated).toBe(false)
  })
  it('范围批注 line_start..line_end 连续高亮', () => {
    const annos = markdownAnnotations({ comments: [{ id: 1, content: '段', author: 'g', target: { line_start: 2, line_end: 4 } }] })
    const rows = buildMarkdownLines(content, annos)
    expect(rows.filter((r) => r.annotated).map((r) => r.n)).toEqual([2, 3, 4])
  })
  it('clampLine 越界裁进范围', () => {
    expect(clampLine(99, 5)).toBe(5)
    expect(clampLine(0, 5)).toBe(1)
    expect(clampLine('3', 5)).toBe(3)
  })
  it('clampPositiveInt: >=1 整数, 无效回退', () => {
    expect(clampPositiveInt(3)).toBe(3)
    expect(clampPositiveInt(0, 1)).toBe(1)
    expect(clampPositiveInt('x', 2)).toBe(2)
  })
  it('firstAnnotatedLine 返回首个批注行(滚动定位用); 无批注=0', () => {
    const annos = markdownAnnotations({ comments: [
      { content: 'a', author: 'g', target: { line_start: 4, line_end: 4 } },
      { content: 'b', author: 'g', target: { line_start: 2, line_end: 2 } },
    ] })
    expect(firstAnnotatedLine(content, annos)).toBe(2)
    expect(firstAnnotatedLine(content, [])).toBe(0)
  })
})

describe('WS 回流事件判别(后端 store.py emit 真集)', () => {
  it('真集含 updated/annotation_added/deleted, 不含 archived', () => {
    expect(REVIEW_EVENTS).toEqual(['created', 'updated', 'verdict_changed', 'comment_added', 'annotation_added', 'pushed', 'deleted'])
    expect(isReviewEvent({ event_type: 'verdict_changed' })).toBe(true)
    expect(isReviewEvent({ type: 'comment_added' })).toBe(true)
    expect(isReviewEvent({ event_type: 'annotation_added' })).toBe(true)
    expect(isReviewEvent({ event_type: 'deleted' })).toBe(true)
    expect(isReviewEvent({ event_type: 'updated' })).toBe(true)
    expect(isReviewEvent({ event_type: 'archived' })).toBe(false)   // 后端无此事件(归档走 updated)
    expect(isReviewEvent({ event_type: 'noise' })).toBe(false)
  })
  it('eventType / eventId 取值: 帧主形态 {event_type, material}', () => {
    expect(reviewEventType({ event_type: 'pushed' })).toBe('pushed')
    // material 嵌套优先(后端真实帧)
    expect(reviewEventId({ event_type: 'verdict_changed', material: { id: 'm3' } })).toBe('m3')
    expect(reviewEventId({ material_id: 'm2' })).toBe('m2')
    expect(reviewEventId({ id: 'm1' })).toBe('m1')
    expect(reviewEventId({})).toBe(null)
  })
})
