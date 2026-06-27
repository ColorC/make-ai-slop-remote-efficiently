// @vitest-environment jsdom
// reviewView UI 状态单测(M4) — 真实驱动控制器(DOM + 拦截 fetch + 假 WebSocket), 锁住:
//   · _stats 角标渲染(mandatory_unaccepted / pushed_unread)
//   · 多选 → batch_verdict / batch_delete 发出正确 payload + 二次确认 + 刷新
//   · include_archived 切换改变列表请求
//   · 6 类 material 渲染: markdown 行号定位 / image 批注覆盖层 / html(live_url) / custom_web_template 兜底 / video / text
//   · 审判/评论发出正确 payload · WS /stream 事件回流刷新详情与列表
// 每例 resetModules 重新 import, 隔离 reviewView 模块级状态(curFilter/sel/conn 等)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DOM = `
  <div id="btnBack"></div><div id="tabbar"></div><div id="toast"></div>
  <div class="view" id="listView">
    <div id="reviewStats"></div>
    <div id="filters"></div>
    <div id="selectBar"></div>
    <div id="list"></div>
  </div>
  <div class="view" id="detailView"><div id="detail"></div></div>
`

// mock 样本对齐真后端: 评论/批注用 content+author+target(无 text/by/anchor);
// 推送态用 pushed_to_user;key_question 的 inline_content 是 JSON 字符串。
const LIST = {
  items: [
    { id: 'm-md', kind: 'markdown', tier: 'mandatory', status: 'pending', title: 'MD 材料', updated_at: '2026-06-27T08:00:00+00:00', pushed_to_user: true },
    { id: 'm-img', kind: 'image', tier: 'important', status: 'pending', title: '图片材料', updated_at: '2026-06-27T08:01:00+00:00' },
    { id: 'm-tpl', kind: 'custom_web_template', tier: 'processual', status: 'pending', title: 'Diff 报告', updated_at: '2026-06-27T08:02:00+00:00' },
  ],
}
const STATS = { total: 9, by_status: { pending: 3 }, by_tier: {}, mandatory_unaccepted: 2, pushed_unread: 5 }

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
  'm-html': {
    id: 'm-html', kind: 'html', tier: 'important', status: 'pending', title: '网页材料', extra: { live_url: '/live/m-html' },
  },
  'm-video': { id: 'm-video', kind: 'video', tier: 'processual', status: 'pending', title: '视频材料' },
  'm-text': { id: 'm-text', kind: 'markdown', tier: 'processual', status: 'pending', title: '纯文本', inline_content: '没有批注的内容' },
  'm-kq': {
    id: 'm-kq', kind: 'key_question', tier: 'mandatory', status: 'pending', title: '关键问题材料',
    inline_content: JSON.stringify({ question: '选 A 还是 B?', options: ['方案 A', '方案 B'], explanation: 'A 更稳' }),
  },
}

function resp(body, { ok = true, status = 200, json = true } = {}) {
  return {
    ok, status,
    headers: { get: () => (json ? 'application/json' : 'text/plain') },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function defaultResponder(url, m) {
  const u = url.split('?')[0]
  if (u.endsWith('/reviewstage/_stats')) return resp(STATS)
  if (u.endsWith('/batch_verdict') || u.endsWith('/batch_delete')) return resp({ ok: true })
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

let calls, responder, review, core
const $ = (id) => document.getElementById(id)

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
  core = await import('../../../../app/www/js/core.js')
  review = await import('../../../../app/www/js/reviewView.js')
  core.store.base = 'http://test'
})
afterEach(() => { vi.unstubAllGlobals() })

function listCalls() { return calls.filter((c) => /\/reviewstage\?/.test(c.url)) }
async function clickModalOk() {
  await vi.waitFor(() => expect(document.querySelector('.modal-ov .modal-ok')).toBeTruthy())
  document.querySelector('.modal-ov .modal-ok').click()
}

describe('列表 + _stats 角标', () => {
  it('渲染卡片 + 角标(强制未过/新推送) + 卡片推送角标', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelectorAll('.card').length).toBe(3))
    await vi.waitFor(() => expect($('reviewStats').textContent).toContain('强制未过'))
    const st = $('reviewStats').textContent
    expect(st).toContain('新推送')
    expect($('reviewStats').querySelector('[data-k="mandatory_unaccepted"] b').textContent).toBe('2')
    expect($('reviewStats').querySelector('[data-k="pushed_unread"] b').textContent).toBe('5')
    expect($('list').querySelector('.b.push')).toBeTruthy()   // m-md 新推送角标
  })
})

describe('include_archived 归档筛选', () => {
  it('默认请求不带 include_archived; 点「含归档」后带 include_archived=1', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelector('.card')).toBeTruthy())
    expect(listCalls().some((c) => c.url.includes('include_archived'))).toBe(false)
    $('chipArchived').click()
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('include_archived=1'))).toBe(true))
  })
})

describe('多选 + 批量动作', () => {
  it('进多选 → 选两项 → 批量通过(二次确认)发 batch_verdict payload', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelector('.card')).toBeTruthy())
    $('chipSelect').click()                                   // 进多选态
    await vi.waitFor(() => expect($('list').querySelector('.card[data-id="m-img"] .selbox')).toBeTruthy())
    $('list').querySelector('.card[data-id="m-md"]').click()
    $('list').querySelector('.card[data-id="m-img"]').click()
    await vi.waitFor(() => expect($('selectBar').textContent).toContain('已选 2'))
    $('selectBar').querySelector('.sb-ok').click()            // 批量通过
    await clickModalOk()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/batch_verdict'))
      expect(c).toBeTruthy()
      expect(c.body.ids).toEqual(['m-md', 'm-img'])
      expect(c.body.verdict).toBe('accepted')
      expect(c.body.by).toBe('lofa-mobile')
    })
  })

  it('全选 → 批量删除发 batch_delete payload(含全部 id)', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelector('.card')).toBeTruthy())
    $('chipSelect').click()
    await vi.waitFor(() => expect($('list').querySelectorAll('.card').length).toBe(3))
    $('sbAll').click()
    await vi.waitFor(() => expect($('selectBar').textContent).toContain('已选 3'))
    $('sbDel').click()
    await clickModalOk()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/batch_delete'))
      expect(c).toBeTruthy()
      expect(c.body.ids).toEqual(['m-md', 'm-img', 'm-tpl'])
    })
  })

  it('取消确认则不发请求', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelector('.card')).toBeTruthy())
    $('chipSelect').click()
    await vi.waitFor(() => expect($('list').querySelector('.card[data-id="m-md"] .selbox')).toBeTruthy())
    $('list').querySelector('.card[data-id="m-md"]').click()
    $('selectBar').querySelector('.sb-bad').click()           // 批量驳回
    await vi.waitFor(() => expect(document.querySelector('.modal-cancel')).toBeTruthy())
    document.querySelector('.modal-cancel').click()
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.some((c) => c.url.endsWith('/batch_verdict'))).toBe(false)
  })
})

describe('6 类 material 渲染', () => {
  it('markdown: 行号定位视图, 第 2 行高亮 + 批注透出', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('detail').querySelector('.mdlines')).toBeTruthy())
    const anno = $('detail').querySelector('.mdline.anno')
    expect(anno).toBeTruthy()
    expect(anno.getAttribute('data-line')).toBe('2')
    expect($('detail').textContent).toContain('这行要改')
  })

  it('image: 批注覆盖层(1 点 + 1 框) + 普通评论进评论区', async () => {
    await review.openDetail('m-img')
    await vi.waitFor(() => expect($('detail').querySelector('.imgwrap')).toBeTruthy())
    expect($('detail').querySelectorAll('.anno-pt').length).toBe(1)
    expect($('detail').querySelectorAll('.anno-rect').length).toBe(1)
    // 无锚点评论落到评论区
    expect($('detail').querySelector('#comments').textContent).toContain('整体不错')
  })

  it('custom_web_template: 兜底卡(标题/模板/说明/字段/链接) + iframe, 不空白', async () => {
    await review.openDetail('m-tpl')
    await vi.waitFor(() => expect($('detail').querySelector('.tpl-card')).toBeTruthy())
    const card = $('detail').querySelector('.tpl-card').textContent
    expect(card).toContain('filetree_diff')
    expect(card).toContain('改了 3 个文件')
    expect(card).toContain('files')
    expect($('detail').querySelector('iframe')).toBeTruthy()
    expect($('detail').querySelector('.web-bar a').getAttribute('href')).toBe('http://test/live/m-tpl')
  })

  it('html(live_url): iframe 指向同源代理链接', async () => {
    await review.openDetail('m-html')
    await vi.waitFor(() => expect($('detail').querySelector('iframe')).toBeTruthy())
    expect($('detail').querySelector('iframe').getAttribute('src')).toBe('http://test/live/m-html')
  })

  it('video: <video> 元素指向 /file', async () => {
    await review.openDetail('m-video')
    await vi.waitFor(() => expect($('detail').querySelector('video')).toBeTruthy())
    expect($('detail').querySelector('video').getAttribute('src')).toContain('/reviewstage/m-video/file')
  })

  it('markdown 无批注: 普通 md 渲染(非行号视图)', async () => {
    await review.openDetail('m-text')
    await vi.waitFor(() => expect($('detail').querySelector('.md')).toBeTruthy())
    expect($('detail').querySelector('.mdlines')).toBeNull()
    expect($('detail').textContent).toContain('没有批注的内容')
  })

  it('key_question: 解析 JSON 成 问题 + 选项 + 说明(不显原始 JSON)', async () => {
    await review.openDetail('m-kq')
    await vi.waitFor(() => expect($('detail').querySelector('.kq')).toBeTruthy())
    expect($('detail').querySelector('.kq-q').textContent).toContain('选 A 还是 B?')
    const opts = $('detail').querySelectorAll('.kq-opt')
    expect(opts.length).toBe(2)
    expect(opts[0].textContent).toContain('方案 A')
    expect($('detail').textContent).toContain('A 更稳')
    // 别把整段 JSON 当文本显出来
    expect($('detail').textContent).not.toContain('"question"')
  })
})

describe('审判 / 评论', () => {
  it('单条通过发 verdict payload', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('actions')).toBeTruthy())
    $('actions').querySelector('.act-ok').click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-md/verdict'))
      expect(c).toBeTruthy()
      expect(c.body).toMatchObject({ verdict: 'accepted', by: 'lofa-mobile' })
    })
  })

  it('评论发 comment payload(无 anchor)', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('actComment')).toBeTruthy())
    $('actComment').click()
    await vi.waitFor(() => expect(document.querySelector('.modal-in')).toBeTruthy())
    document.querySelector('.modal-in').value = '总体可以'
    document.querySelector('.modal-ok').click()
    await vi.waitFor(() => {
      const c = calls.find((x) => x.method === 'POST' && x.url.endsWith('/m-md/comment'))
      expect(c).toBeTruthy()
      expect(c.body).toEqual({ content: '总体可以', author: 'lofa-mobile' })
    })
  })

  it('详情打开会对未读推送材料发 mark_pushed', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('/m-md/mark_pushed') && c.method === 'POST')).toBe(true))
  })
})

describe('WS /stream 回流', () => {
  it('打开了 stream WS(复用任务 1 helper)', async () => {
    await review.loadList()
    await vi.waitFor(() => expect(FakeWS.last).toBeTruthy())
    expect(FakeWS.last.url).toBe('ws://test/api/boss-sight/reviewstage/stream')
  })

  it('详情开着时, 命中当前材料的 verdict_changed 事件(帧 {event_type,material}) → 重载详情', async () => {
    await review.openDetail('m-md')
    await vi.waitFor(() => expect($('detail').querySelector('.mdlines')).toBeTruthy())
    const before = calls.filter((c) => c.url.endsWith('/reviewstage/m-md')).length
    FakeWS.last.emit({ event_type: 'verdict_changed', material: { id: 'm-md' } })
    await vi.waitFor(() => {
      const after = calls.filter((c) => c.url.endsWith('/reviewstage/m-md')).length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('列表显示时, comment_added 事件(嵌 material) → 去抖刷新列表', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelector('.card')).toBeTruthy())
    const before = listCalls().length
    FakeWS.last.emit({ event_type: 'comment_added', material: { id: 'm-img' } })
    await vi.waitFor(() => expect(listCalls().length).toBeGreaterThan(before), { timeout: 1500 })
  })

  it('deleted 事件(后端真集)也触发刷新', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelector('.card')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 500))
    const before = listCalls().length
    FakeWS.last.emit({ event_type: 'deleted', material: { id: 'm-tpl' } })
    await vi.waitFor(() => expect(listCalls().length).toBeGreaterThan(before), { timeout: 1500 })
  })

  it('非审阅事件被忽略', async () => {
    await review.loadList()
    await vi.waitFor(() => expect($('list').querySelector('.card')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 500))   // 冲掉上一例可能遗留的去抖计时器
    const before = listCalls().length
    FakeWS.last.emit({ event_type: 'noise', material: { id: 'x' } })
    await new Promise((r) => setTimeout(r, 600))
    expect(listCalls().length).toBe(before)
  })
})
