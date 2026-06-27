// Playwright 审阅流程(M4) — 驱动真实 app/www 页面, REST + WS /stream 全 mock。
// 覆盖 test_strategy: 列表→详情→6 类 material 渲染→审判→批注→模拟 WS 回流→批量审判。
// 同时验: _stats 角标、include_archived 切换、custom_web_template 兜底卡不空白。
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5599'
const WS_GLOB = '**/api/boss-sight/reviewstage/stream'

// 有状态 mock(对齐真后端形态): 评论/批注 content+author+target;推送态 pushed_to_user;
// key_question 的 inline_content 是 JSON。审判/批注后改材料, WS 回流后详情/列表能读到新态。
function freshStore() {
  const materials = {
    'm-md': {
      id: 'm-md', kind: 'markdown', tier: 'mandatory', status: 'pending', title: 'MD 设计稿', pushed_to_user: true,
      updated_at: '2026-06-27T08:00:00+00:00', inline_content: '标题行\n第二行需要改\n第三行\n第四行', annotations: [],
      comments: [{ id: 'cmt_1', author: 'grace', content: '这一行改一下', target: { line_start: 2, line_end: 2 } }],
    },
    'm-img': {
      id: 'm-img', kind: 'image', tier: 'important', status: 'pending', title: '图片材料',
      updated_at: '2026-06-27T08:01:00+00:00',
      annotations: [
        { id: 'ann_2', author: 'controller', kind: 'ai', content: '这个点要注意', target: { x: 0.5, y: 0.4 } },
        { id: 'ann_3', author: 'controller', kind: 'ai', content: '这块区域', target: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } },
      ],
      comments: [{ id: 'cmt_4', author: 'grace', content: '整体可以', target: {} }],
    },
    'm-html': { id: 'm-html', kind: 'html', tier: 'important', status: 'pending', title: '网页材料', updated_at: '2026-06-27T08:02:00+00:00', extra: { live_url: '/live/m-html' } },
    'm-tpl': {
      id: 'm-tpl', kind: 'custom_web_template', tier: 'processual', status: 'pending', title: 'Diff 报告',
      updated_at: '2026-06-27T08:03:00+00:00',
      extra: { template: 'filetree_diff', description: '改了 3 个文件', live_url: '/live/m-tpl', files: ['a.ts', 'b.ts', 'c.ts'] },
    },
    'm-video': { id: 'm-video', kind: 'video', tier: 'processual', status: 'pending', title: '视频材料', updated_at: '2026-06-27T08:04:00+00:00' },
    'm-kq': {
      id: 'm-kq', kind: 'key_question', tier: 'mandatory', status: 'pending', title: '关键问题材料', updated_at: '2026-06-27T08:05:00+00:00',
      inline_content: JSON.stringify({ question: '选 A 还是 B?', options: ['方案 A', '方案 B'], explanation: 'A 更稳' }),
    },
  }
  return { materials, ws: null, batch: [] }
}

function listOf(store, includeArchived) {
  return Object.values(store.materials)
    .filter((m) => includeArchived || !m.archived)
    .map((m) => ({ id: m.id, kind: m.kind, tier: m.tier, status: m.status, title: m.title, updated_at: m.updated_at, pushed_to_user: !!m.pushed_to_user, archived: !!m.archived }))
}

async function setupRoutes(page, store) {
  await page.addInitScript((base) => { try { localStorage.setItem('lofa.baseUrl', base) } catch (e) {} }, BASE)
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/healthz', (r) => json(r, { ok: true }))
  await page.route('**/api/android/register', (r) => json(r, { ok: true }))
  await page.route('**/api/android/log', (r) => json(r, { ok: true }))
  await page.route('**/api/android/apk/version', (r) => json(r, { manifest: null }))
  await page.route('**/api/boss-sight/residents', (r) => json(r, { residents: [] }))

  // 通用 /reviewstage/** 处理(详情/file/verdict/comment/batch); 后注册的更具体端点先命中。
  await page.route('**/api/boss-sight/reviewstage/**', async (r) => {
    const url = r.request().url().split('?')[0]
    const method = r.request().method()
    const tail = url.split('/reviewstage/')[1] || ''
    if (tail === 'batch_verdict') {
      const body = r.request().postDataJSON() || {}
      const ids = body.ids || []
      ids.forEach((id) => { if (store.materials[id]) store.materials[id].status = body.verdict })
      store.batch.push({ kind: 'verdict', body })
      // 真后端键: changed_count / changed_ids / not_found / skipped
      return json(r, { ok: true, changed_count: ids.length, changed_ids: ids, not_found: [], skipped: [] })
    }
    if (tail === 'batch_delete') {
      const body = r.request().postDataJSON() || {}
      const ids = body.ids || []
      ids.forEach((id) => { delete store.materials[id] })
      store.batch.push({ kind: 'delete', body })
      // 真后端键: deleted_count / deleted_ids / skipped_pending / not_found
      return json(r, { ok: true, deleted_count: ids.length, deleted_ids: ids, skipped_pending: 0, not_found: [] })
    }
    const vm = tail.match(/^([^/]+)\/verdict$/)
    if (vm) { const body = r.request().postDataJSON() || {}; const m = store.materials[decodeURIComponent(vm[1])]; if (m) m.status = body.verdict; return json(r, m || { ok: true }) }
    const cm = tail.match(/^([^/]+)\/comment$/)
    if (cm) {
      const body = r.request().postDataJSON() || {}; const m = store.materials[decodeURIComponent(cm[1])]
      // 后端 CommentBody = {content, author, target}
      if (m) { (m.comments = m.comments || []).push({ id: 'cmt_' + Math.floor(Math.random() * 1e6), author: body.author, content: body.content, target: body.target || {} }) }
      return json(r, { ok: true })
    }
    if (/^[^/]+\/mark_pushed$/.test(tail)) { const id = decodeURIComponent(tail.split('/')[0]); if (store.materials[id]) store.materials[id].pushed_to_user = false; return json(r, { ok: true }) }
    if (/^[^/]+\/file$/.test(tail)) return r.fulfill({ status: 200, contentType: 'text/plain', body: '文件正文' })
    // 详情
    const id = decodeURIComponent(tail)
    return json(r, store.materials[id] || { id, kind: 'markdown', tier: 'processual', status: 'pending', title: '?', inline_content: 'x' })
  })
  // 更具体端点(后注册 → 先命中)
  await page.route('**/api/boss-sight/reviewstage/_stats', (r) => json(r, {
    total: 9, by_status: { pending: 3 }, by_tier: { mandatory: 2 }, mandatory_unaccepted: 2, pushed_unread: 5,
  }))
  await page.route('**/api/boss-sight/reviewstage?*', (r) => {
    const includeArchived = /include_archived=1/.test(r.request().url())
    return json(r, { items: listOf(store, includeArchived), total: Object.keys(store.materials).length })
  })

  // WS /stream: 保留服务端句柄, 测试主动推回流事件。
  await page.routeWebSocket(WS_GLOB, (ws) => { store.ws = ws; ws.onMessage(() => {}) })
}

async function gotoReview(page) {
  await page.goto('/')
  await expect(page.locator('#dot')).toHaveClass(/ok/, { timeout: 8000 })   // 连上即默认进审阅 tab
  await expect(page.locator('#listView')).toHaveClass(/show/)
}

test.describe('LOFA 审阅流程(M4, 对齐电脑端审阅台)', () => {
  let store
  test.beforeEach(async ({ page }) => { store = freshStore(); await setupRoutes(page, store) })

  // 详情→断言→返回列表(稳: 每次返回都等 listView 复位再开下一张)
  async function open(page, id) {
    await page.locator('#list .card[data-id="' + id + '"]').click()
    await expect(page.locator('#detailView')).toHaveClass(/show/)
  }
  async function back(page) {
    await page.locator('#btnBack').click()
    await expect(page.locator('#listView')).toHaveClass(/show/)
  }

  test('列表 + _stats 角标 + 6 类 material 各渲染', async ({ page }) => {
    test.slow()   // 6 次材料开合, 放宽超时
    await gotoReview(page)

    // 列表 6 张卡 + _stats 角标(强制未过/新推送) + 推送角标
    await expect(page.locator('#list .card')).toHaveCount(6)
    await expect(page.locator('#reviewStats')).toContainText('强制未过')
    await expect(page.locator('#reviewStats [data-k="pushed_unread"] b')).toHaveText('5')
    await expect(page.locator('#list .card[data-id="m-md"] .b.push')).toBeVisible()

    // 1) markdown 行号定位: 第 2 行高亮 + 批注透出
    await open(page, 'm-md')
    await expect(page.locator('.mdline.anno[data-line="2"]')).toBeVisible()
    await expect(page.locator('#detail')).toContainText('这一行改一下')
    await back(page)

    // 2) image: 批注覆盖层(1 点 + 1 框) + 普通评论入评论区
    await open(page, 'm-img')
    await expect(page.locator('.imgwrap .anno-pt')).toHaveCount(1)
    await expect(page.locator('.imgwrap .anno-rect')).toHaveCount(1)
    await expect(page.locator('#comments')).toContainText('整体可以')
    await back(page)

    // 3) custom_web_template 兜底卡: 标题/模板/说明/字段/链接 + iframe, 不空白
    await open(page, 'm-tpl')
    await expect(page.locator('.tpl-card')).toContainText('filetree_diff')
    await expect(page.locator('.tpl-card')).toContainText('改了 3 个文件')
    await expect(page.locator('.tpl-card')).toContainText('files')
    await expect(page.locator('#detail iframe')).toBeVisible()
    await expect(page.locator('#detail .web-bar a')).toHaveAttribute('href', BASE + '/live/m-tpl')
    await back(page)

    // 4) html(live_url): iframe 指向同源代理
    await open(page, 'm-html')
    await expect(page.locator('#detail iframe')).toHaveAttribute('src', BASE + '/live/m-html')
    await back(page)

    // 5) video: <video> 指向 /file
    await open(page, 'm-video')
    await expect(page.locator('#detail video')).toHaveAttribute('src', /\/reviewstage\/m-video\/file/)
    await back(page)

    // 6) key_question: inline_content 是 JSON, 渲染成问题+选项+说明(不显原始 JSON)
    await open(page, 'm-kq')
    await expect(page.locator('#detail .kq-q')).toContainText('选 A 还是 B?')
    await expect(page.locator('#detail .kq-opt')).toHaveCount(2)
    await expect(page.locator('#detail')).toContainText('A 更稳')
    await expect(page.locator('#detail')).not.toContainText('"question"')
  })

  test('审判 → 评论 → WS /stream 回流刷新详情', async ({ page }) => {
    await gotoReview(page)
    await page.locator('#list .card[data-id="m-md"]').click()
    await expect(page.locator('#detailView')).toHaveClass(/show/)

    // 审判通过 → WS 回流 verdict_changed(帧 {event_type, material}) → 详情状态翻 accepted
    await page.locator('#actions .act-ok').click()
    await store.ws.send(JSON.stringify({ event_type: 'verdict_changed', material: { id: 'm-md' } }))
    await expect(page.locator('#detail .b.st-accepted')).toBeVisible({ timeout: 7000 })

    // 评论提交, 回流后评论区可见
    await page.locator('#actComment').click()
    await page.locator('.modal-in').fill('补充一句评论')
    await page.locator('.modal-ok').click()
    await expect(page.locator('#comments')).toContainText('补充一句评论')
  })

  test('include_archived 归档筛选: 切换后请求带 include_archived=1', async ({ page }) => {
    store.materials['m-arc'] = { id: 'm-arc', kind: 'markdown', tier: 'processual', status: 'accepted', title: '归档材料', archived: true, inline_content: 'x' }
    await gotoReview(page)
    await expect(page.locator('#list .card')).toHaveCount(6)   // 默认不含归档
    const [req] = await Promise.all([
      page.waitForRequest((r) => /include_archived=1/.test(r.url())),
      page.locator('#chipArchived').click(),
    ])
    expect(req.url()).toContain('include_archived=1')
    await expect(page.locator('#list .card[data-id="m-arc"]')).toBeVisible()
    await expect(page.locator('#list .card[data-id="m-arc"] .b.arc')).toContainText('归档')
  })

  test('多选 → 批量审判: 选两项通过, 发 batch_verdict', async ({ page }) => {
    await gotoReview(page)
    await expect(page.locator('#list .card')).toHaveCount(6)
    await page.locator('#chipSelect').click()
    await expect(page.locator('#selectBar')).toHaveClass(/show/)
    await page.locator('#list .card[data-id="m-md"]').click()
    await page.locator('#list .card[data-id="m-kq"]').click()
    await expect(page.locator('#selectBar .selcount')).toHaveText('已选 2')
    await page.locator('#selectBar .sb-ok').click()
    await page.locator('.modal-ov .modal-ok').click()           // 二次确认
    await expect.poll(() => store.batch.length).toBeGreaterThan(0)
    const b = store.batch.find((x) => x.kind === 'verdict')
    expect(b.body.ids.sort()).toEqual(['m-kq', 'm-md'])
    expect(b.body.verdict).toBe('accepted')
    // 回流: 列表项 m-md 已不在 pending(默认筛选)
    await store.ws.send(JSON.stringify({ event_type: 'verdict_changed', material: { id: 'm-md' } }))
  })

  test('多选 → 批量删除: 全选删除, 发 batch_delete', async ({ page }) => {
    await gotoReview(page)
    await expect(page.locator('#list .card')).toHaveCount(6)
    await page.locator('#chipSelect').click()
    await page.locator('#sbAll').click()
    await expect(page.locator('#selectBar .selcount')).toHaveText('已选 6')
    await page.locator('#sbDel').click()
    await page.locator('.modal-ov .modal-ok').click()
    await expect.poll(() => store.batch.some((x) => x.kind === 'delete')).toBe(true)
    const b = store.batch.find((x) => x.kind === 'delete')
    expect(b.body.ids).toHaveLength(6)
  })
})
