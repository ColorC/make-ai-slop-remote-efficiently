// @vitest-environment jsdom
// reviewView UI 状态单测 — 真实驱动控制器(DOM + 拦截 fetch + 假 WebSocket
// + 真实 router/ui),锁住新形态下的行为(对齐 UI-REDESIGN-V2 §7e/§11c):
//   · 时间桶分组列表渲染 + 分段(待审/已处理/全部)+ 「筛选」sheet(层级单选/含已归档/清除)
//   · 搜索框前端过滤标题
//   · 「选择」进多选 → 行首勾选框 → 底部操作条批量 verdict / 删除(二次确认)
//   · 详情推入页: 6 类 material 渲染(markdown 行号定位/图片批注/网页/模板兜底/视频/key_question)
//   · 详情底条 通过/驳回/搁置/评论;三点菜单 归档/标已读/复制链接;打开自动标已读
//   · WS /stream 回流刷新详情与列表 —— 手机单栏(详情推入后列表隐藏)不刷新列表 /
//     平板 split(≥840,列表与详情同屏)即使 isDetail() 为真也要刷新列表(regression)
// 每例 resetModules 重新 import,隔离 reviewView/router 模块级状态。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DOM = `
  <div id="toast"></div>
  <div id="bannerBar" class="lg-banner"><span class="lg-banner-dot"></span><span class="lg-banner-text"></span></div>
  <nav id="bottomNav"></nav>
  <div id="viewport">
    <section class="view split-master" id="reviewView"></section>
    <section class="view split-detail" id="reviewDetailView"></section>
  </div>
`

const NOW = Date.now()
const isoAgo = (ms) => new Date(NOW - ms).toISOString()
const T_TODAY = isoAgo(2 * 3600 * 1000)
const T_YESTERDAY = isoAgo(26 * 3600 * 1000)
const T_OLDER = isoAgo(10 * 24 * 3600 * 1000)

// mock 样本对齐真后端: 评论/批注用 content+author+target(无 text/by/anchor);
// 推送态用 pushed_to_user;key_question 的 inline_content 是 JSON 字符串。
const LIST = {
  items: [
    { id: 'm-md', kind: 'markdown', tier: 'mandatory', status: 'pending', title: 'MD 材料', updated_at: T_TODAY, pushed_to_user: true, source_plan_id: 'lofa/[2026-06-27]X' },
    { id: 'm-img', kind: 'image', tier: 'important', status: 'pending', title: '图片材料', updated_at: T_YESTERDAY },
    { id: 'm-tpl', kind: 'custom_web_template', tier: 'processual', status: 'pending', title: 'Diff 报告', updated_at: T_OLDER },
  ],
}
const STATS = {
  total: 9, by_status: { pending: 3, accepted: 4, rejected: 1, blocked: 1 },
  by_tier: { mandatory: 1, important: 1, processual: 1 }, mandatory_unaccepted: 2, pushed_unread: 5,
}
const DETAIL = {
  'm-md': {
    id: 'm-md', kind: 'markdown', tier: 'mandatory', status: 'pending', title: 'MD 材料', pushed_to_user: true,
    inline_content: '第一行\n第二行需改\n第三行\n第四行', annotations: [],
    comments: [{ id: 'cmt_1', author: 'grace', content: '这行要改', target: { line_start: 2, line_end: 2 } }],
  },
  'm-img': {
    id: 'm-img', kind: 'image', tier: 'important', status: 'pending', title: '图片材料',
    annotations: [
      { id: 'ann_2', author: 'controller', kind: 'ai', content: '看这个点', target: { x: 0.5, y: 0.4 } },
      { id: 'ann_3', author: 'controller', kind: 'ai', content: '看这块区域', target: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } },
    ],
    comments: [{ id: 'cmt_4', author: 'grace', content: '整体不错', target: {} }],
  },
  'm-tpl': {
    id: 'm-tpl', kind: 'custom_web_template', tier: 'processual', status: 'pending', title: 'Diff 报告',
    extra: { template: 'filetree_diff', description: '改了 3 个文件', files: ['a.ts', 'b.ts', 'c.ts'], live_url: '/live/m-tpl' },
  },
  'm-html': { id: 'm-html', kind: 'html', tier: 'important', status: 'pending', title: '网页材料', extra: { live_url: '/live/m-html' } },
  'm-demo': {
    id: 'm-demo', kind: 'demo', tier: 'important', status: 'pending', title: 'EP0 网页成片正式候选',
    extra: { live_url: 'http://10.3.43.246:8210/bilibili-video/ep00-meta-first/pipeline/ep00_review_v12.html?source=v32' },
  },
  'm-static': { id: 'm-static', kind: 'static-report', tier: 'important', status: 'pending', title: '静态报告' },
  'm-html-legacy': {
    id: 'm-html-legacy', kind: 'legacy-report', tier: 'important', status: 'pending', title: '旧网页材料',
    inline_content: '<!doctype html><html><body>legacy</body></html>',
  },
  'm-video': { id: 'm-video', kind: 'video', tier: 'processual', status: 'pending', title: '视频材料' },
  'm-text': { id: 'm-text', kind: 'markdown', tier: 'processual', status: 'pending', title: '纯文本', inline_content: '没有批注的内容' },
  'm-text-note': { id: 'm-text-note', kind: 'markdown', tier: 'processual', status: 'pending', title: 'Text note', inline_content: 'Selectable saved text', comments: [{ id: 'ct1', author: 'mobile', content: 'Needs revision', target: { text_quote: 'saved text', prefix: 'Selectable ', suffix: '' } }] },
  'm-kq': {
    id: 'm-kq', kind: 'key_question', tier: 'mandatory', status: 'pending', title: '关键问题材料',
    inline_content: JSON.stringify({ question: '选 A 还是 B?', options: ['方案 A', '方案 B'], explanation: 'A 更稳' }),
  },
}

function resp(body, { ok = true, status = 200, json = true } = {}) {
  // 每次调用都深拷贝: 视图层会就地改写取回的 material(如 curMaterial.status = v),
  // 若直接返回 fixture 引用会跨用例互相污染(真实后端每次响应都是独立对象,不会有此问题)。
  const clone = () => (typeof body === 'string' ? body : JSON.parse(JSON.stringify(body)))
  return {
    ok, status,
    headers: { get: () => (json ? 'application/json' : 'text/plain') },
    json: async () => clone(),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}
function defaultResponder(url) {
  const u = url.split('?')[0]
  if (u.endsWith('/reviewstage/_stats')) return resp(STATS)
  if (u.endsWith('/batch_verdict') || u.endsWith('/batch_delete')) return resp({ ok: true, changed_count: 1, deleted_count: 1 })
  const dm = u.match(/\/reviewstage\/([^/]+)$/)
  if (dm) return resp(DETAIL[decodeURIComponent(dm[1])] || { id: dm[1], kind: 'markdown', tier: 'processual', status: 'pending', title: '?', inline_content: 'x' })
  if (/\/reviewstage\/[^/]+\/(verdict|comment|archive|mark_pushed)$/.test(u)) return resp({ ok: true })
  if (/\/reviewstage\/[^/]+\/file$/.test(u)) return resp('文件正文', { json: false })
  if (u.endsWith('/reviewstage')) return resp(LIST)
  return resp({ ok: true })
}

// 假 WebSocket: 捕获实例供测试主动 emit 回流帧。
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 1; FakeWS.last = this; FakeWS.all.push(this); setTimeout(() => { if (this.onopen) this.onopen() }, 0) }
  send() {}
  close() { this.readyState = 3 }
  emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }) }
}
FakeWS.all = []; FakeWS.last = null

let calls, responder, review, core, router
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel))

function setWidth(w) { Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true }) }
function installMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn((query) => ({
    get matches() {
      if (String(query).includes('min-width')) return window.innerWidth >= 840
      return false
    },
    media: String(query),
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })))
}
// jsdom 不跑真动画,animationend 不会自动触发;手动派发模拟转场完成(master 页此时才真正隐藏)。
function finishPushAnim() {
  const el = document.querySelector('.view.anim-in')
  if (el) el.dispatchEvent(new Event('animationend'))
}
function finishPopAnim() {
  const el = document.querySelector('.view.anim-out')
  if (el) el.dispatchEvent(new Event('animationend'))
}
function selectNodeText(node, start = 0, end = null, doc = document) {
  const text = node.firstChild
  const range = doc.createRange()
  range.setStart(text, start)
  range.setEnd(text, end == null ? text.nodeValue.length : end)
  const selection = doc.defaultView.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  doc.dispatchEvent(new Event('selectionchange'))
  return { range, selection }
}

beforeEach(async () => {
  vi.resetModules()
  document.body.innerHTML = DOM
  calls = []
  responder = defaultResponder
  FakeWS.all = []; FakeWS.last = null
  vi.stubGlobal('WebSocket', FakeWS)
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url), m = (opts.method || 'GET').toUpperCase()
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, method: m, body })
    if (u.includes('/api/android/log')) return resp({ ok: true })
    return responder(u, m, body)
  }))
  setWidth(375)
  installMatchMedia()
  core = await import('../../../../app/www/js/core.js')
  router = await import('../../../../app/www/js/router.js')
  review = await import('../../../../app/www/js/reviewView.js')
  core.store.base = 'http://test'
  review.init()
  router.init({ tabs: { review: 'reviewView' }, defaultTab: 'review' })
})
afterEach(() => { vi.unstubAllGlobals() })

function listCalls() { return calls.filter((c) => /\/reviewstage\?/.test(c.url)) }
function detailCalls(id) { return calls.filter((c) => c.method === 'GET' && c.url.endsWith('/reviewstage/' + id)) }
async function clickModalOk() {
  await vi.waitFor(() => expect($('.lg-modal-ok')).toBeTruthy())
  $('.lg-modal-ok').click()
}

describe('列表:时间桶分组 + 分段(§11c)', () => {
  it('渲染 3 行分进 今天/昨天/更早 三个时间桶', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    const heads = $$('#reviewList .lg-sec-head').map((h) => h.textContent)
    expect(heads).toEqual(['今天1', '昨天1', '更早1'])
  })
  it('分段三段(待审/已处理/全部);新推送标只在 pushed_to_user+pending 行', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    const segs = $$('#reviewSeg button').map((b) => b.textContent)
    expect(segs).toEqual(['待审3', '已处理', '全部'])
    const mdRow = $('#reviewList .rv-row[data-id="m-md"]')
    expect(mdRow.querySelector('.lg-newtag')).toBeTruthy()
    const imgRow = $('#reviewList .rv-row[data-id="m-img"]')
    expect(imgRow.querySelector('.lg-newtag')).toBeNull()
  })
})

describe('筛选切换发出正确请求(§11c 分段 + 筛选 sheet)', () => {
  it('默认「待审」发 status=pending;切「全部」不带 status', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    expect(listCalls().some((c) => c.url.includes('status=pending'))).toBe(true)
    $('#reviewSeg button[data-v="all"]').click()
    await vi.waitFor(() => expect(listCalls()[listCalls().length - 1].url.includes('status=')).toBe(false))
  })
  it('筛选 sheet:含已归档 toggle 后带 include_archived=1,pill 现角标', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    expect(listCalls().some((c) => c.url.includes('include_archived'))).toBe(false)
    $('#reviewFilterPill').click()
    await vi.waitFor(() => expect($('#reviewArchToggle')).toBeTruthy())
    $('#reviewArchToggle').click()
    await vi.waitFor(() => expect(listCalls().some((c) => c.url.includes('include_archived=1'))).toBe(true))
    expect($('#reviewFilterPill .rv-filter-badge').textContent).toBe('1')
  })
  it('筛选 sheet:层级单选带 tier= 参数;选「全部层级」取消', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    $('#reviewFilterPill').click()
    await vi.waitFor(() => expect($('#reviewFilterSheet .lg-sheet-radio[data-tier="important"]')).toBeTruthy())
    $('#reviewFilterSheet .lg-sheet-radio[data-tier="important"]').click()
    await vi.waitFor(() => expect(listCalls().some((c) => c.url.includes('tier=important'))).toBe(true))
    const before = listCalls().length
    $('#reviewFilterSheet .lg-sheet-radio[data-tier=""]').click()
    await vi.waitFor(() => expect(listCalls().length).toBeGreaterThan(before))
    expect(listCalls()[listCalls().length - 1].url.includes('tier=')).toBe(false)
  })
})

describe('搜索(前端过滤标题,不发新请求)', () => {
  it('输入关键词只保留匹配标题的行', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    const before = listCalls().length
    const input = $('#reviewSearch')
    input.value = 'Diff'
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(1))
    expect($('#reviewList .rv-row').getAttribute('data-id')).toBe('m-tpl')
    expect(listCalls().length).toBe(before)   // 纯前端过滤, 不重新请求
  })
})

describe('mobile text selection comments', () => {
  it('creates a Markdown quote+line target from the selected text', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('.rv-mdline[data-line="2"] .tx')).toBeTruthy())
    selectNodeText($('.rv-mdline[data-line="2"] .tx'), 0, 5)
    await vi.waitFor(() => expect($('#rvSelectionComment')).toBeTruthy())
    expect($('#rvSelectionComment').textContent).toBe('\u8bc4\u8bba\u9009\u4e2d\u5185\u5bb9')
    $('#rvSelectionComment').click()
    await vi.waitFor(() => expect($('.lg-modal-in')).toBeTruthy())
    $('.lg-modal-in').value = 'Selected passage note'
    $('.lg-modal-ok').click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-md/comment'))
      expect(c.body.target).toMatchObject({ text_quote: '\u7b2c\u4e8c\u884c\u9700\u6539', line_start: 2, line_end: 2 })
      expect(c.body.target.prefix).toContain('\u7b2c\u4e00\u884c')
    })
  })

  it('ignores collapsed selections and removes the action when leaving detail', async () => {
    await review.openDetail('m-text')
    await vi.waitFor(() => expect($('.rv-md p')).toBeTruthy())
    const node = $('.rv-md p').firstChild
    const range = document.createRange(); range.setStart(node, 1); range.collapse(true)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise((r) => setTimeout(r, 180))
    expect($('#rvSelectionComment')).toBeNull()

    selectNodeText($('.rv-md p'), 0, 4)
    await vi.waitFor(() => expect($('#rvSelectionComment')).toBeTruthy())
    $('#reviewDetailView .lg-nav-back').click()
    expect($('#rvSelectionComment')).toBeNull()
  })

  it('captures text selected inside a same-origin web iframe', async () => {
    await review.openDetail('m-html')
    await vi.waitFor(() => expect($('.rv-web iframe')).toBeTruthy())
    const frame = $('.rv-web iframe')
    const doc = frame.contentDocument
    doc.open(); doc.write('<!doctype html><html><body><p id="web-copy">Web selectable copy</p></body></html>'); doc.close()
    frame.dispatchEvent(new Event('load'))
    await new Promise((r) => setTimeout(r, 0))
    selectNodeText(doc.getElementById('web-copy'), 0, 14, doc)
    await vi.waitFor(() => expect($('#rvSelectionComment')).toBeTruthy())
    $('#rvSelectionComment').click()
    await vi.waitFor(() => expect($('.lg-modal-in')).toBeTruthy())
    $('.lg-modal-in').value = 'Web quote note'
    $('.lg-modal-ok').click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-html/comment'))
      expect(c.body.target).toMatchObject({ text_quote: 'Web selectable', selector: '#web-copy', url: 'http://test/live/m-html' })
    })
  })

  it('keeps saved text anchors visible through a compact notes sheet', async () => {
    await review.openDetail('m-text-note')
    await vi.waitFor(() => expect($('#rvTextNotes')).toBeTruthy())
    expect($('#rvTextNotes').textContent).toBe('\u6279\u6ce8 1')
    $('#rvTextNotes').click()
    await vi.waitFor(() => expect($('#rvTextNotesSheet')).toBeTruthy())
    expect($('#rvTextNotesSheet').textContent).toContain('saved text')
    expect($('#rvTextNotesSheet').textContent).toContain('Needs revision')
  })
})

describe('多选 → 批量动作', () => {
  it('「选择」进多选 → 勾两行 → 批量通过(二次确认)发 batch_verdict payload', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    const selectBtn = $('#reviewSelect')
    selectBtn.click()
    await vi.waitFor(() => expect($('#reviewList .rv-cb')).toBeTruthy())
    $('#reviewList .rv-row[data-id="m-md"]').click()
    $('#reviewList .rv-row[data-id="m-img"]').click()
    await vi.waitFor(() => expect($('#reviewActions').textContent).toContain('已选 2'))
    $('#reviewActions [data-v="accepted"]').click()
    await clickModalOk()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/batch_verdict'))
      expect(c).toBeTruthy()
      expect(c.body.ids).toEqual(['m-md', 'm-img'])
      expect(c.body.verdict).toBe('accepted')
      expect(c.body.by).toBe('lofa-mobile')
    })
  })

  it('全选 → 批量删除发 batch_delete payload(含全部可见 id)', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    $('#reviewSelect').click()
    await vi.waitFor(() => expect($('#reviewActions')).toBeTruthy())
    $('#reviewActions #rvSelAll').click()
    await vi.waitFor(() => expect($('#reviewActions').textContent).toContain('已选 3'))
    $('#reviewActions #rvSelDel').click()
    await clickModalOk()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/batch_delete'))
      expect(c).toBeTruthy()
      expect(c.body.ids).toEqual(['m-md', 'm-img', 'm-tpl'])
    })
  })

  it('取消确认则不发请求', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    $('#reviewSelect').click()
    await vi.waitFor(() => expect($('#reviewList .rv-cb')).toBeTruthy())
    $('#reviewList .rv-row[data-id="m-md"]').click()
    $('#reviewActions [data-v="rejected"]').click()
    await vi.waitFor(() => expect($('.lg-modal-cancel')).toBeTruthy())
    $('.lg-modal-cancel').click()
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.some((c) => c.url.endsWith('/batch_verdict'))).toBe(false)
  })
})

describe('详情推入页: 6 类 material 渲染', () => {
  it('markdown: 行号定位视图, 第 2 行高亮 + 批注透出', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('.rv-mdlines')).toBeTruthy())
    const anno = $('.rv-mdline.anno')
    expect(anno.getAttribute('data-line')).toBe('2')
    expect($('#reviewDetailBody').textContent).toContain('这行要改')
  })

  it('image: 批注覆盖层(1 点 + 1 框) + 普通评论进评论区', async () => {
    await review.openDetail('m-img')
    await vi.waitFor(() => expect($('.rv-imgwrap')).toBeTruthy())
    expect($$('.rv-anno-pt').length).toBe(1)
    expect($$('.rv-anno-rect').length).toBe(1)
    expect($('.rv-detail-comments').textContent).toContain('整体不错')
  })

  it('custom_web_template: 兜底卡(标题/模板/说明/字段/链接) + iframe, 不空白', async () => {
    await review.openDetail('m-tpl')
    await vi.waitFor(() => expect($('.rv-web iframe')).toBeTruthy())
    expect($('.rv-tpl')).toBeNull()
    expect($('.rv-web-bar')).toBeNull()
    expect($('.rv-web iframe').getAttribute('src')).toBe('http://test/live/m-tpl')
  })

  it('html(live_url): iframe 指向同源代理链接', async () => {
    await review.openDetail('m-html')
    await vi.waitFor(() => expect($('.rv-web iframe')).toBeTruthy())
    expect($('.rv-web iframe').getAttribute('src')).toBe('http://test/live/m-html')
  })

  it('demo:作为网页渲染,旧 8210 地址归一到正式同源网关', async () => {
    core.store.base = 'https://10.3.43.246:12443'
    await review.openDetail('m-demo')
    await vi.waitFor(() => expect($('.rv-web iframe')).toBeTruthy())
    expect($('.rv-web iframe').getAttribute('src'))
      .toBe('https://10.3.43.246:12443/bilibili-video/ep00-meta-first/pipeline/ep00_review_v12.html?source=v32')
    expect($('.rv-md')).toBeNull()
  })

  it('static-report:无 live_url 时 iframe 指向权威 /file 路由', async () => {
    await review.openDetail('m-static')
    await vi.waitFor(() => expect($('.rv-web iframe')).toBeTruthy())
    expect($('.rv-web iframe').getAttribute('src')).toBe('http://test/api/boss-sight/reviewstage/m-static/file')
  })

  it('未知旧 kind 的完整 HTML 正文也转 iframe,不显示源码', async () => {
    await review.openDetail('m-html-legacy')
    await vi.waitFor(() => expect($('.rv-web iframe')).toBeTruthy())
    expect($('.rv-md')).toBeNull()
  })

  it('网页与 Markdown 默认保持内容优先但不自动进入全屏', async () => {
    await review.openDetail('m-html')
    const view = $('#reviewDetailView')
    expect(view.classList.contains('rv-content-first')).toBe(true)
    expect(view.classList.contains('rv-web-detail')).toBe(true)
    expect(view.classList.contains('rv-immersive')).toBe(false)
    expect(document.body.classList.contains('review-immersive-active')).toBe(false)

    await review.openDetail('m-text')
    expect(view.classList.contains('rv-markdown-detail')).toBe(true)
    expect(view.classList.contains('rv-immersive')).toBe(false)
  })

  it('video: <video> 元素指向 /file', async () => {
    await review.openDetail('m-video')
    await vi.waitFor(() => expect($('.rv-video video')).toBeTruthy())
    expect($('.rv-video video').getAttribute('src')).toContain('/reviewstage/m-video/file')
  })

  it('markdown 无批注: 普通 md 渲染(非行号视图)', async () => {
    await review.openDetail('m-text')
    await vi.waitFor(() => expect($('.rv-md')).toBeTruthy())
    expect($('.rv-mdlines')).toBeNull()
    expect($('#reviewDetailBody').textContent).toContain('没有批注的内容')
  })

  it('key_question: 解析 JSON 成 问题 + 选项 + 说明(不显原始 JSON)', async () => {
    await review.openDetail('m-kq')
    await vi.waitFor(() => expect($('.rv-kq-q')).toBeTruthy())
    expect($('.rv-kq-q').textContent).toContain('选 A 还是 B?')
    const opts = $$('.rv-kq-opt')
    expect(opts.length).toBe(2)
    expect(opts[0].textContent).toContain('方案 A')
    expect($('#reviewDetailBody').textContent).toContain('A 更稳')
    expect($('#reviewDetailBody').textContent).not.toContain('"question"')
  })
})

describe('详情底条(通过/驳回/搁置/评论) + 三点菜单 + 自动标已读', () => {
  it('底条通过发 verdict payload', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('#reviewDetailBar [data-v="accepted"]')).toBeTruthy())
    $('#reviewDetailBar [data-v="accepted"]').click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-md/verdict'))
      expect(c).toBeTruthy()
      expect(c.body).toMatchObject({ verdict: 'accepted', by: 'lofa-mobile' })
    })
  })

  it('搁置按钮发 verdict=blocked', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('#reviewDetailBar [data-v="blocked"]')).toBeTruthy())
    expect($('#reviewDetailBar [data-v="blocked"]').textContent).toBe('搁置')
    $('#reviewDetailBar [data-v="blocked"]').click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-md/verdict'))
      expect(c.body.verdict).toBe('blocked')
    })
  })

  it('评论按钮发 comment payload(无 anchor)', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('#rvComment')).toBeTruthy())
    $('#rvComment').click()
    await vi.waitFor(() => expect($('.lg-modal-in')).toBeTruthy())
    $('.lg-modal-in').value = '总体可以'
    $('.lg-modal-ok').click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-md/comment'))
      expect(c).toBeTruthy()
      expect(c.body).toEqual({ content: '总体可以', author: 'lofa-mobile' })
    })
  })

  it('打开详情只读, 不把后端 mark_pushed 误当成标已读', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('.rv-mdlines')).toBeTruthy())
    expect(calls.some((c) => c.url.endsWith('/m-md/mark_pushed') && c.method === 'POST')).toBe(false)
  })

  it('三点菜单: 归档 / 复制链接', async () => {
    await review.openDetail('m-tpl')
    await vi.waitFor(() => expect($('#reviewDetailMore')).toBeTruthy())
    $('#reviewDetailMore').click()
    await vi.waitFor(() => expect($$('.lg-menu-item').length).toBe(7))
    const items = $$('.lg-menu-item').map((b) => b.textContent)
    expect(items).toEqual(['通过', '搁置', '驳回', '评论', '在浏览器打开', '归档', '复制链接'])
    $$('.lg-menu-item')[5].click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-tpl/archive'))
      expect(c).toBeTruthy()
      expect(c.body).toMatchObject({ archived: true, by: 'lofa-mobile' })
    })
  })
})

describe('沉浸阅读(§11b)', () => {
  it('内容优先材料默认沉浸;顶栏按钮可退出并再次进入', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('#reviewImmersive')).toBeTruthy())
    const v = document.getElementById('reviewDetailView')
    expect(v.classList.contains('rv-immersive')).toBe(false)
    $('#reviewImmersive').click()
    expect(v.classList.contains('rv-immersive')).toBe(true)
    expect(document.body.classList.contains('review-immersive-active')).toBe(true)
    $('#reviewImmersive').click()
    expect(v.classList.contains('rv-immersive')).toBe(false)
    expect(document.body.classList.contains('review-immersive-active')).toBe(false)
  })
})

describe('返回:详情页返回键调 router.pop()', () => {
  it('点返回后详情页不再显示', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    await review.openDetail('m-md')
    await vi.waitFor(() => expect(document.getElementById('reviewDetailView').classList.contains('show')).toBe(true))
    $('.lg-nav-back').click()
    finishPopAnim()
    await vi.waitFor(() => expect(document.getElementById('reviewDetailView').classList.contains('show')).toBe(false))
  })
})

describe('WS /stream 回流', () => {
  it('打开了 stream WS', async () => {
    await review.load()
    await vi.waitFor(() => expect(FakeWS.last).toBeTruthy())
    expect(FakeWS.last.url).toBe('ws://test/api/boss-sight/reviewstage/stream')
  })

  it('详情开着时, 命中当前材料的 verdict_changed 事件 → 重载详情', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('.rv-mdlines')).toBeTruthy())
    const before = detailCalls('m-md').length
    FakeWS.last.emit({ event_type: 'verdict_changed', material: { id: 'm-md' } })
    await vi.waitFor(() => expect(detailCalls('m-md').length).toBeGreaterThan(before))
  })

  it('列表可见时, comment_added 事件 → 去抖刷新列表', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    const before = listCalls().length
    FakeWS.last.emit({ event_type: 'comment_added', material: { id: 'm-img' } })
    await vi.waitFor(() => expect(listCalls().length).toBeGreaterThan(before), { timeout: 1500 })
  })

  it('非审阅事件被忽略', async () => {
    await review.load()
    await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
    await new Promise((r) => setTimeout(r, 500))
    const before = listCalls().length
    FakeWS.last.emit({ event_type: 'noise', material: { id: 'x' } })
    await new Promise((r) => setTimeout(r, 600))
    expect(listCalls().length).toBe(before)
  })

  describe('分栏守卫: 列表刷新只看列表是否可见, 不是简单 !isDetail()', () => {
    it('手机单栏: 详情推入后列表隐藏 → verdict_changed 不刷新列表, 只刷新详情', async () => {
      await review.load()
      await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
      await review.openDetail('m-md')
      await vi.waitFor(() => expect(document.getElementById('reviewDetailView').classList.contains('show')).toBe(true))
      finishPushAnim()
      expect(document.getElementById('reviewView').classList.contains('show')).toBe(false)
      const beforeList = listCalls().length
      const beforeDetail = detailCalls('m-md').length
      FakeWS.last.emit({ event_type: 'verdict_changed', material: { id: 'm-md' } })
      await vi.waitFor(() => expect(detailCalls('m-md').length).toBeGreaterThan(beforeDetail))
      await new Promise((r) => setTimeout(r, 600))
      expect(listCalls().length).toBe(beforeList)
    })

    it('平板 split(≥840): 列表与详情同屏可见 → verdict_changed 两者都刷新(不被 isDetail 误挡)', async () => {
      setWidth(1024)
      await review.load()
      await vi.waitFor(() => expect($$('#reviewList .rv-row').length).toBe(3))
      await review.openDetail('m-md')
      await vi.waitFor(() => expect(document.getElementById('reviewDetailView').classList.contains('show')).toBe(true))
      expect(document.getElementById('reviewView').classList.contains('show')).toBe(true)
      expect(document.body.classList.contains('split-active')).toBe(true)
      const beforeList = listCalls().length
      const beforeDetail = detailCalls('m-md').length
      FakeWS.last.emit({ event_type: 'verdict_changed', material: { id: 'm-md' } })
      await vi.waitFor(() => {
        expect(listCalls().length).toBeGreaterThan(beforeList)
        expect(detailCalls('m-md').length).toBeGreaterThan(beforeDetail)
      }, { timeout: 1500 })
    })
  })
})
