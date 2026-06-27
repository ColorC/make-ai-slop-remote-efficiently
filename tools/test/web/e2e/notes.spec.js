// Playwright 笔记流程 — 驱动真实 app/www 页面, REST 全 mock(有状态 authored store)。
// 覆盖 test_strategy: 进 Notes→浏览 KB→搜索→打开 markdown 详情→创建 authored→编辑保存后列表更新。
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5599'

function freshCtx() {
  return {
    authored: [
      { id: 'note_seed', content: '已有的一条札记', title: '', author: 'user', feedback_status: 'saved', archived: false, uses: ['comment'], target: {}, project_id: 'unfiled' },
    ],
    seq: 0,
  }
}

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.replace(/^\s*#{1,6}\s*/, '').trim()).find(Boolean) || ''

async function setupRoutes(page, ctx) {
  await page.addInitScript((base) => { try { localStorage.setItem('lofa.baseUrl', base) } catch (e) {} }, BASE)
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  // 壳 / 连接 / 轮询(连上后默认进审阅 tab, 这些必须有响应)
  await page.route('**/api/healthz', (r) => json(r, { ok: true }))
  await page.route('**/api/android/register', (r) => json(r, { ok: true }))
  await page.route('**/api/android/log', (r) => json(r, { ok: true }))
  await page.route('**/api/android/apk/version', (r) => json(r, { manifest: null }))
  await page.route('**/api/boss-sight/reviewstage/_stats', (r) => json(r, { by_status: { pending: 0 }, pushed_unread: 0 }))
  await page.route('**/api/boss-sight/residents', (r) => json(r, { residents: [] }))
  await page.route('**/api/boss-sight/reviewstage?*', (r) => json(r, { items: [] }))

  // ── KB 只读 ──
  const KB = {
    'kb/welcome': { id: 'kb/welcome', title: '欢迎', path: 'docs/kb/welcome.md', content: '# 欢迎\n这是 **只读** 的 KB 文档\n- 要点一\n- 要点二' },
    'kb/guide': { id: 'kb/guide', title: '指南', path: 'docs/kb/guide.md', content: '# 指南\n指南正文' },
  }
  await page.route('**/api/notes**', (r) => {
    const url = r.request().url()
    if (url.includes('/_search')) {
      const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [, ''])[1])
      const items = Object.values(KB)
        .filter((n) => (n.title + n.content + n.id).includes(q))
        .map((n) => ({ id: n.id, title: n.title, snippet: '…' + n.content.slice(0, 30).replace(/\n/g, ' ') + '…' }))
      return json(r, { items, total: items.length })
    }
    if (/\/api\/notes$/.test(url.split('?')[0])) {
      return json(r, { items: Object.values(KB).map(({ id, title, path }) => ({ id, title, path, size: 1, mtime: 1 })), total: Object.keys(KB).length })
    }
    const id = decodeURIComponent(url.split('/api/notes/')[1].split('?')[0])
    return KB[id] ? json(r, KB[id]) : json(r, { detail: 'note not found' }, 404)
  })

  // ── authored 可写(有状态) ──
  await page.route('**/api/boss-sight/notes**', async (r) => {
    const req = r.request()
    const url = req.url()
    const method = req.method()
    const after = url.split('/api/boss-sight/notes')[1] || ''
    const idMatch = after.match(/^\/([^/?]+)/)
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1])
      const note = ctx.authored.find((n) => n.id === id)
      if (method === 'GET') return note ? json(r, note) : json(r, { detail: 'not found' }, 404)
      if (method === 'PUT') {
        const b = req.postDataJSON() || {}
        if (b.content != null) note.content = b.content
        if (b.title != null) note.title = b.title
        return json(r, note)
      }
      if (method === 'DELETE') { note.archived = true; return json(r, { archived: true, id }) }
    }
    if (method === 'POST') {
      const b = req.postDataJSON() || {}
      const n = { id: 'note_new_' + (++ctx.seq), content: b.content, title: '', author: b.author || 'user', feedback_status: 'saved', archived: false, uses: b.uses || ['comment'], target: {}, project_id: 'unfiled' }
      ctx.authored.unshift(n)
      return json(r, n)
    }
    // GET 列表(排除已归档)
    return json(r, { count: ctx.authored.filter((n) => !n.archived).length, items: ctx.authored.filter((n) => !n.archived) })
  })
}

async function gotoNotes(page) {
  await page.goto('/')
  await expect(page.locator('#dot')).toHaveClass(/ok/, { timeout: 8000 })
  await page.locator('#tabNotes').click()
  await expect(page.locator('#notesView')).toHaveClass(/show/)
}

test.describe('LOFA 笔记流程(M2)', () => {
  let ctx
  test.beforeEach(async ({ page }) => { ctx = freshCtx(); await setupRoutes(page, ctx) })

  test('浏览 KB→搜索→打开 markdown 详情(只读)', async ({ page }) => {
    await gotoNotes(page)
    // 默认 KB 来源, 列表出现, 卡片标只读
    await expect(page.locator('#notesList .card', { hasText: '欢迎' })).toBeVisible()
    await expect(page.locator('#notesList')).toContainText('只读')

    // 搜索
    await page.locator('#notesQ').fill('指南')
    await page.locator('#notesQBtn').click()
    await expect(page.locator('#notesList .card', { hasText: '指南' })).toBeVisible()
    await expect(page.locator('#notesList .card')).toHaveCount(1)

    // 清空搜索回到全量, 打开 KB 详情
    await page.locator('#notesQ').fill('')
    await page.locator('#notesQBtn').click()
    await page.locator('#notesList .card', { hasText: '欢迎' }).click()
    await expect(page.locator('#noteDetailView')).toHaveClass(/show/)
    await expect(page.locator('#noteContent h1')).toHaveText('欢迎')        // markdown 渲染
    await expect(page.locator('#noteDetail')).toContainText('只读')
    await expect(page.locator('#noteEditBtn')).toHaveCount(0)               // KB 不可写
    await expect(page.locator('#noteDelBtn')).toHaveCount(0)
  })

  test('创建 authored→编辑保存后列表更新', async ({ page }) => {
    await gotoNotes(page)
    // 切到「我的札记」来源
    await page.locator('.chip[data-s="authored"]').click()
    await expect(page.locator('#notesList .card', { hasText: '已有的一条札记' })).toBeVisible()
    await expect(page.locator('#notesList')).toContainText('可写')

    // 写札记
    await page.locator('#notesNew').click()
    await expect(page.locator('#noteEditArea')).toBeVisible()
    await page.locator('#noteEditArea').fill('手机端新写的札记')
    await page.locator('#noteSaveBtn').click()
    // 保存后回列表(已切到 authored), 新条目可见
    await expect(page.locator('#notesView')).toHaveClass(/show/)
    await expect(page.locator('#notesList .card', { hasText: '手机端新写的札记' })).toBeVisible()

    // 打开新札记 → 编辑 → 保存 → 列表更新
    await page.locator('#notesList .card', { hasText: '手机端新写的札记' }).click()
    await expect(page.locator('#noteEditBtn')).toBeVisible()
    await page.locator('#noteEditBtn').click()
    await page.locator('#noteEditArea').fill('编辑后的札记内容')
    await page.locator('#noteSaveBtn').click()
    await expect(page.locator('#notesView')).toHaveClass(/show/)
    await expect(page.locator('#notesList .card', { hasText: '编辑后的札记内容' })).toBeVisible()
    await expect(page.locator('#notesList .card', { hasText: '手机端新写的札记' })).toHaveCount(0)
  })
})
