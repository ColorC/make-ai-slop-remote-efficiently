// reviewState.js — 审阅 tab 的纯函数适配层(无 DOM, node 可单测)。
//
// M4 把电脑端审阅台「动作集 + material 类型覆盖」归一成可被 Vitest 锁住的纯逻辑,
// 让 reviewView 只管 DOM。对齐已核实后端(base /api/boss-sight/reviewstage):
//   列表  GET ?status=&tier=&plan_id=&include_archived=&pushed_only=&limit=
//   角标  GET /_stats → {total, by_status{}, by_tier{}, mandatory_unaccepted, pushed_unread}
//   单审判 POST /{id}/verdict {verdict,by,reason} · 评论 POST /{id}/comment {content,author,target}
//   批量审判 POST /batch_verdict {ids[],verdict,by,reason} → {changed_count,changed_ids,not_found,skipped:[{id,error}]}
//   批量删 POST /batch_delete {ids[],include_pending,...} → {deleted_count,deleted_ids,skipped_pending,not_found}
//   归档 POST /{id}/archive {archived,by} · 标已读 POST /{id}/mark_pushed
//   正文 GET /{id}/file · WS /stream({event_type, material}) —— event_type ∈
//     {created,updated,verdict_changed,comment_added,annotation_added,pushed,deleted}(store.py emit 真集)
//
// 设计成纯函数, 让"选择 reducer / 批量 payload / include_archived 参数 / _stats 角标 /
// 图片坐标归一化 / markdown 行号定位 / custom_web_template 兜底"都能脱离浏览器单测。

export const BASE_PATH = '/api/boss-sight/reviewstage'
export const BY = 'lofa-mobile'
export const VERDICT_REASON = 'LOFA 手机端审阅'

export const encId = (id) => encodeURIComponent(String(id == null ? '' : id))

// ── 列表筛选 chips(状态)+ 审判动作 ─────────────────────────────────────────
export const FILTERS = [
  ['pending', '待审'], ['accepted', '通过'], ['rejected', '驳回'], ['blocked', '阻断'], ['', '全部'],
]
export const DEFAULT_FILTER = 'pending'
export const VERDICTS = [
  { value: 'accepted', label: '通过', done: '已通过' },
  { value: 'rejected', label: '驳回', done: '已驳回' },
  { value: 'blocked', label: '阻断', done: '已阻断' },
]
export function verdictDone(v) {
  const hit = VERDICTS.find((x) => x.value === v)
  return hit ? hit.done : '已记录'
}

// ── 列表查询(include_archived 切换在此, 默认沿用电脑端不带归档) ───────────────
export function listQuery(opts) {
  opts = opts || {}
  const parts = ['limit=' + (opts.limit || 100)]
  if (opts.status) parts.push('status=' + encodeURIComponent(opts.status))
  if (opts.tier) parts.push('tier=' + encodeURIComponent(opts.tier))
  if (opts.plan_id) parts.push('plan_id=' + encodeURIComponent(opts.plan_id))
  if (opts.include_archived) parts.push('include_archived=1')
  if (opts.pushed_only) parts.push('pushed_only=1')
  return parts.join('&')
}

// ── 路径工具(集中, 单测锁定) ────────────────────────────────────────────────
export function listPath(opts) { return BASE_PATH + '?' + listQuery(opts) }
export function detailPath(id) { return BASE_PATH + '/' + encId(id) }
export function filePath(id) { return detailPath(id) + '/file' }
export function statsPath() { return BASE_PATH + '/_stats' }
export function verdictPath(id) { return detailPath(id) + '/verdict' }
export function commentPath(id) { return detailPath(id) + '/comment' }
export function archivePath(id) { return detailPath(id) + '/archive' }
export function markPushedPath(id) { return detailPath(id) + '/mark_pushed' }
export function batchVerdictPath() { return BASE_PATH + '/batch_verdict' }
export function batchDeletePath() { return BASE_PATH + '/batch_delete' }
// WS 回流端点: http→ws / https→wss(复用任务 1 的 openReconnectingWs 句柄)。
export function streamWsUrl(base) { return String(base || '').replace(/^http/, 'ws') + BASE_PATH + '/stream' }

// ── 多选 reducer(批量动作的状态核心, 单测锁定) ───────────────────────────────
//   mode=是否处于多选态;ids=已选 material id(去重, 保序)。纯函数, 返回新 state。
export const SELECTION_INIT = { mode: false, ids: [] }
function uniq(arr) {
  const seen = {}, out = []
  ;(arr || []).forEach((x) => { const k = String(x); if (x != null && !seen[k]) { seen[k] = 1; out.push(x) } })
  return out
}
export function selectionReducer(state, action) {
  state = state || SELECTION_INIT
  action = action || {}
  switch (action.type) {
    case 'enter': return { mode: true, ids: [] }
    case 'exit': return { mode: false, ids: [] }
    case 'clear': return { mode: state.mode, ids: [] }
    case 'set': {
      const has = state.ids.indexOf(action.id) >= 0
      if (action.on && !has) return { mode: true, ids: uniq(state.ids.concat([action.id])) }
      if (!action.on && has) return { mode: state.mode, ids: state.ids.filter((x) => x !== action.id) }
      return state
    }
    case 'toggle': {
      const has = state.ids.indexOf(action.id) >= 0
      return has
        ? { mode: state.mode, ids: state.ids.filter((x) => x !== action.id) }
        : { mode: true, ids: uniq(state.ids.concat([action.id])) }
    }
    case 'selectAll': return { mode: true, ids: uniq(action.ids) }
    default: return state
  }
}
export function selHas(state, id) { return !!state && state.ids.indexOf(id) >= 0 }
export function selCount(state) { return state ? state.ids.length : 0 }
export function selIds(state) { return state ? state.ids.slice() : [] }

// ── 单/批量 审判·评论·删除 payload(单测锁定) ────────────────────────────────
export function buildVerdictPayload(verdict, opts) {
  opts = opts || {}
  return { verdict, by: opts.by || BY, reason: opts.reason || VERDICT_REASON }
}
export function buildBatchVerdictPayload(ids, verdict, opts) {
  opts = opts || {}
  return { ids: uniq(ids), verdict, by: opts.by || BY, reason: opts.reason || VERDICT_REASON }
}
export function buildBatchDeletePayload(ids, opts) {
  opts = opts || {}
  const body = { ids: uniq(ids), by: opts.by || BY }
  if (opts.reason) body.reason = opts.reason
  return body
}
// 后端 CommentBody = {content, author, target?}(routes.py)。发 {text,by,anchor} 会被
// Pydantic 拒(content 必填缺失 → 422)。定位锚点进 target(后端 Comment.target 即定位),
// 不另起 anchor 字段。target 形态对齐后端 store.py: image {x,y,w,h}/markdown {line_start,line_end}。
export function buildCommentPayload(text, opts) {
  opts = opts || {}
  const body = { content: String(text == null ? '' : text), author: opts.by || BY }
  const target = opts.target || (opts.anchor ? anchorToTarget(opts.anchor) : null)
  if (target && Object.keys(target).length) body.target = target
  return body
}
export function buildArchivePayload(archived, opts) {
  opts = opts || {}
  return { archived: !!archived, by: opts.by || BY }
}

// 批量操作的「局部失败 / 跳过」归一 —— 读 routes.py 真实响应键:
//   batch_verdict → {changed_count, changed_ids, not_found:[id], skipped:[{id,error}]}
//   batch_delete  → {deleted_count, deleted_ids, skipped_pending:int, not_found:[id]}
// 统一成 {total, ok, failed:[{id,error}], skippedPending}。
//   - ok = changed_count / deleted_count(后端真处理数);拿不到时回退 total-失败-跳过。
//   - failed = not_found(后端没找到)+ skipped(verdict 执行报错, [{id,error}])。
//   - skippedPending = batch_delete 选中 pending 但未 include_pending 时被跳过的数量
//     (语义是"按预期未删,需勾选含待审才删", view 据此提示, 不当成"已处理")。
export function summarizeBatch(resp, ids) {
  resp = resp || {}
  const failed = []
  ;(Array.isArray(resp.not_found) ? resp.not_found : []).forEach((id) => {
    failed.push({ id, error: '未找到' })
  })
  ;(Array.isArray(resp.skipped) ? resp.skipped : []).forEach((s) => {
    failed.push(typeof s === 'object' ? { id: s.id, error: s.error || '失败' } : { id: s, error: '失败' })
  })
  const skippedPending = typeof resp.skipped_pending === 'number' ? resp.skipped_pending : 0
  const total = (ids || []).length
  let ok
  if (typeof resp.changed_count === 'number') ok = resp.changed_count
  else if (typeof resp.deleted_count === 'number') ok = resp.deleted_count
  else ok = total - failed.length - skippedPending
  return { total, ok, failed, skippedPending }
}

// ── _stats 角标映射(至少 mandatory_unaccepted / pushed_unread) ───────────────
export function statsBadges(stats) {
  stats = stats || {}
  const by = stats.by_status || {}
  const n = (v) => (typeof v === 'number' ? v : (parseInt(v, 10) || 0))
  return [
    { key: 'pending', label: '待审', count: n(by.pending) },
    { key: 'mandatory_unaccepted', label: '强制未过', count: n(stats.mandatory_unaccepted) },
    { key: 'pushed_unread', label: '新推送', count: n(stats.pushed_unread) },
  ]
}

// ── 卡片角标(material 上的 pushed/mandatory 标记, 列表项级) ─────────────────
// 后端 Material 真字段: pushed_to_user(bool) + status。无 pushed_unread/pushed_read 这类字段。
// "未读推送"判定对齐后端 _stats 口径: pushed_to_user && status==pending(routes.py material_stats)。
export function cardFlags(m) {
  m = m || {}
  const tier = String(m.tier || '').toLowerCase()
  const status = String(m.status || '').toLowerCase()
  return {
    pushedUnread: !!m.pushed_to_user && status === 'pending',
    mandatory: tier === 'mandatory',
    archived: !!m.archived,
  }
}

// ── material kind 归一 + custom_web_template 兜底 ───────────────────────────
// 网页类与后端/桌面端保持一致: html / custom_web_template / static-report / demo
// 都走 iframe;custom_web_template 另出兜底卡。
// 注: 'live_url' 不是 kind,而是材料 extra 中的可选实时地址。
export function normalizeMaterialKind(kind) {
  return String(kind == null ? '' : kind).trim().toLowerCase()
}

export function isWebKind(kind) {
  const k = normalizeMaterialKind(kind)
  return k === 'html' || k === 'custom_web_template' || k === 'custom-web-template' ||
    k === 'static-report' || k === 'static_report' || k === 'demo' || k === 'web' || k === 'web-demo'
}
export function isImageKind(kind) {
  const k = normalizeMaterialKind(kind)
  return k === 'image' || k === 'aigc-image' || k === 'aigc_image'
}
export function isVideoKind(kind) { return normalizeMaterialKind(kind) === 'video' }
export function isKeyQuestionKind(kind) {
  const k = normalizeMaterialKind(kind)
  return k === 'key_question' || k === 'key-question'
}

function materialContentType(m) {
  const ex = (m && m.extra) || {}
  const preflight = ex.remote_preflight || {}
  return String(m && (m.content_type || m.mime_type) || ex.content_type || ex.mime_type || preflight.content_type || '').toLowerCase()
}
function materialFileName(m) {
  const ex = (m && m.extra) || {}
  return String(m && (m.file_relpath || m.file_path || m.path || m.filename) || ex.file_relpath || ex.file_path || ex.path || '')
}

export function isWebMaterial(m) {
  if (!m) return false
  if (isWebKind(m.kind)) return true
  const ex = m.extra || {}
  if (String(ex.live_url || '').trim()) return true
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(materialContentType(m))) return true
  if (/\.(?:html?|xhtml)(?:[?#].*)?$/i.test(materialFileName(m))) return true
  return looksLikeHtmlDoc(m.inline_content)
}

export function looksLikeHtmlDoc(text) {
  return /^\s*<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i.test(String(text == null ? '' : text))
}

export function templateName(m) {
  const ex = (m && m.extra) || {}
  return m && (m.template || ex.template || ex.template_name) || ''
}

// live_url(同源代理 /xxx 优先)否则 /file。
// 历史材料可能写死 http://同主机:8210;手机正式入口走 12443 时直接使用会触发
// 混合内容/防火墙问题,因此将同主机的旧 8210 或 https→http 地址归一到当前 base origin。
export function resolveWebUrl(m, base) {
  base = base || ''
  const ex = (m && m.extra) || {}
  const lu = String(ex.live_url || '').trim()
  if (lu) {
    if (lu.charAt(0) === '/' && lu.slice(0, 2) !== '//') return base + lu
    try {
      const baseUrl = new URL(base)
      const liveUrl = new URL(lu, baseUrl)
      const sameHost = liveUrl.hostname.toLowerCase() === baseUrl.hostname.toLowerCase()
      const legacyGateway = liveUrl.port === '8210'
      const insecureDowngrade = baseUrl.protocol === 'https:' && liveUrl.protocol === 'http:'
      if (sameHost && (legacyGateway || insecureDowngrade)) {
        return baseUrl.origin + liveUrl.pathname + liveUrl.search + liveUrl.hash
      }
      return liveUrl.href
    } catch (e) {
      // 无法解析的旧脏值不应破坏审阅页;文件路由仍是可审阅的权威兜底。
    }
  }
  return base + filePath(m && m.id)
}

function stringifyField(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch (e) { return String(v) }
}

// custom_web_template(及 filetree_diff 等无专用 renderer 的模板)兜底卡:
// 至少给 标题 / 模板名 / 说明 / 原始字段 / 可访问链接 —— 绝不空白崩溃。
const TPL_SKIP = { live_url: 1, template: 1, template_name: 1, description: 1, summary: 1 }
export function templateFallbackCard(m, base) {
  m = m || {}
  const ex = m.extra || {}
  const fields = Object.keys(ex)
    .filter((k) => !TPL_SKIP[k])
    .map((k) => ({ key: k, value: stringifyField(ex[k]) }))
    .filter((f) => f.value !== '')
  return {
    title: m.title || '(无标题)',
    template: templateName(m),
    description: ex.description || ex.summary || m.summary || '',
    fields,
    url: resolveWebUrl(m, base || ''),
    hasLiveUrl: !!ex.live_url,
  }
}

// ── key_question 解析(第 6 类 material) ─────────────────────────────────────
// 后端 key_question 的 inline_content 是 JSON 字符串(/file 返回 application/json),
// 解析成 {question, options[], explanation}(对齐电脑端 KeyQuestionMaterialView)。
// 解析失败 → {ok:false, raw}, view 退原始文本(别当 markdown 显原始 JSON)。
export function parseKeyQuestion(content) {
  const raw = content == null ? '' : String(content)
  let parsed = null
  try { parsed = raw ? JSON.parse(raw) : null } catch (e) { parsed = null }
  if (!parsed || typeof parsed !== 'object') return { ok: false, raw }
  const options = Array.isArray(parsed.options) ? parsed.options.map((o) => String(o == null ? '' : o)) : []
  return {
    ok: true,
    question: String(parsed.question == null ? '' : parsed.question),
    options,
    explanation: String(parsed.explanation == null ? '' : parsed.explanation),
    raw,
  }
}

// ── 批注(annotation)/ 评论归一: 列表/详情的批注点 ─────────────────────────
// 后端把批注放在 material.annotations(Annotation)与 comments(Comment), 都用 target 字段
// 定位(store.py Annotation/Comment.to_dict + docstring)。target 按 material kind 不同, 无 type:
//   图片(image)   {x, y, w, h}            归一化 0..1, 有 w/h → 框, 无 → 点
//   markdown      {line_start, line_end}  1-based 行号
//   html          {selector: "..."}       CSS 选择器(本端不定位, 当普通评论)
//   key_question  {question_index: n}     (本端不定位, 当普通评论)
// 据字段推断类型, 绝不要求 target.type。
export function normAnchor(t) {
  if (!t || typeof t !== 'object') return null
  // markdown 行号: line_start / line_end(后端真实键)
  if (t.line_start != null || t.line_end != null) {
    const line = clampPositiveInt(t.line_start != null ? t.line_start : t.line_end, 1)
    const end = clampPositiveInt(t.line_end != null ? t.line_end : t.line_start, line)
    return { type: 'line', line, lineEnd: Math.max(line, end) }
  }
  // 图片坐标: 有 x/y 即定位; 有 w/h(且 >0)→ 框, 否则点
  if (t.x != null || t.y != null) {
    const hasRect = t.w != null && t.h != null && Number(t.w) > 0 && Number(t.h) > 0
    if (hasRect) {
      return { type: 'rect', x: clamp01(t.x), y: clamp01(t.y), w: clamp01(t.w), h: clamp01(t.h) }
    }
    return { type: 'point', x: clamp01(t.x), y: clamp01(t.y) }
  }
  return null
}
// 把本端归一 anchor 转回后端 target 形态(发评论/批注用)。
export function anchorToTarget(anchor) {
  if (!anchor || typeof anchor !== 'object') return {}
  if (anchor.type === 'line') {
    const s = clampPositiveInt(anchor.line, 1)
    const e = clampPositiveInt(anchor.lineEnd != null ? anchor.lineEnd : anchor.line, s)
    return { line_start: s, line_end: Math.max(s, e) }
  }
  if (anchor.type === 'rect') {
    return { x: clamp01(anchor.x), y: clamp01(anchor.y), w: clamp01(anchor.w), h: clamp01(anchor.h) }
  }
  if (anchor.type === 'point') {
    return { x: clamp01(anchor.x), y: clamp01(anchor.y) }
  }
  return {}
}
// 后端 Comment/Annotation 真实字段: content(正文)+ author(作者)+ target(定位)。
export function normAnnotation(c) {
  if (!c) return null
  const anchor = normAnchor(c.target)
  return {
    id: c.id != null ? c.id : null,
    by: c.author || '',
    text: c.content || '',
    at: c.created_at || '',
    anchor,
  }
}
// 后端 material 同时有 annotations(AI 批注 Annotation)与 comments(用户评论 Comment),
// 两者都用 target 定位。合并两路(批注在前, 评论在后), 各自按 target 推断锚点。
export function extractAnnotations(m) {
  if (!m) return []
  const annos = Array.isArray(m.annotations) ? m.annotations : []
  const cmts = Array.isArray(m.comments) ? m.comments : []
  return annos.concat(cmts).map(normAnnotation).filter(Boolean)
}
// 仅带定位锚点的(覆盖层/行高亮用);无 anchor 的是普通评论。
export function imageAnnotations(m) {
  return extractAnnotations(m).filter((a) => a.anchor && (a.anchor.type === 'point' || a.anchor.type === 'rect'))
}
export function markdownAnnotations(m) {
  return extractAnnotations(m).filter((a) => a.anchor && a.anchor.type === 'line')
}
export function plainComments(m) {
  return extractAnnotations(m).filter((a) => !a.anchor)
}

// ── 坐标归一: 归一化(0..1) → 渲染图屏幕像素 ─────────────────────────────────
export function clamp01(n) {
  n = Number(n)
  if (!isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
// 解析成 >=1 的整数, 无效则回退 fallback。
export function clampPositiveInt(v, fallback) {
  const n = parseInt(v, 10)
  return isFinite(n) && n >= 1 ? n : (fallback || 1)
}
export function imageAnchorToScreen(anchor, size) {
  size = size || {}
  const W = Number(size.width) || 0, H = Number(size.height) || 0
  if (!anchor) return null
  if (anchor.type === 'rect') {
    return {
      type: 'rect',
      left: clamp01(anchor.x) * W, top: clamp01(anchor.y) * H,
      width: clamp01(anchor.w) * W, height: clamp01(anchor.h) * H,
    }
  }
  return { type: 'point', left: clamp01(anchor.x) * W, top: clamp01(anchor.y) * H }
}

// ── markdown 行号定位: 把内容切成带行号的行, 标注批注行 ───────────────────────
export function clampLine(line, total) {
  let n = parseInt(line, 10)
  if (!isFinite(n) || n < 1) n = 1
  if (total && n > total) n = total
  return n
}
export function buildMarkdownLines(content, annotations) {
  const lines = String(content == null ? '' : content).split(/\r?\n/)
  const byLine = {}
  ;(annotations || []).forEach((a) => {
    if (!a || !a.anchor || a.anchor.type !== 'line') return
    const s = clampLine(a.anchor.line, lines.length)
    const e = clampLine(a.anchor.lineEnd || a.anchor.line, lines.length)
    for (let n = s; n <= e; n++) { (byLine[n] = byLine[n] || []).push(a) }
  })
  return lines.map((text, i) => {
    const n = i + 1
    return { n, text, annotated: !!byLine[n], notes: byLine[n] || [] }
  })
}
// 第一个批注行(滚动定位用); 无批注返回 0。
export function firstAnnotatedLine(content, annotations) {
  const rows = buildMarkdownLines(content, annotations)
  const hit = rows.find((r) => r.annotated)
  return hit ? hit.n : 0
}

// ── WS 回流事件归一(复用任务 1 ws.js, 此处只做映射判别) ──────────────────────
// 后端 store.py _notify 真实 emit 集(subscribe docstring): 无 'archived'(软归档走 'updated'),
// 补 'updated'/'annotation_added'/'deleted'。WS 帧 = {event_type, material}(routes.py 嵌套实体),
// 'active_material'/'ping'/'snapshot' 是控制帧不在审阅刷新事件里。
export const REVIEW_EVENTS = [
  'created', 'updated', 'verdict_changed', 'comment_added', 'annotation_added', 'pushed', 'deleted',
]
export function reviewEventType(ev) { return ev && (ev.event_type || ev.type) || '' }
export function isReviewEvent(ev) { return REVIEW_EVENTS.indexOf(reviewEventType(ev)) >= 0 }
// 帧主形态 {event_type, material}; 兼容 material_id / 顶层 id(部分控制帧)。
export function reviewEventId(ev) {
  ev = ev || {}
  return (ev.material && ev.material.id != null) ? ev.material.id
    : ev.material_id != null ? ev.material_id
      : ev.id != null ? ev.id : null
}
