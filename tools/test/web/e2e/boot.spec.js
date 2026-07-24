// Playwright 启动冒烟 — 驱动真实 app/www 页面,REST 全 mock。地基工人验收:
//   无 pageerror · 底部 4 tab 渲染且可切换 · 默认落会话 tab · 我的分组列表渲染 ·
//   连接编辑页可打开 · ambient 背景层存在 · 同屏 backdrop-filter 元素 ≤2。
import { test, expect } from '@playwright/test'

// https 基址:getSaved() 迁移作废 http:// 存值,https 存活 → store.base 命中本地址,healthz 被 mock。
const BASE = 'https://localhost:5599'

async function setupRoutes(page) {
  await page.addInitScript((base) => { try { localStorage.setItem('lofa.baseUrl', base) } catch (e) {} }, BASE)
  const json = (r, body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/healthz', (r) => json(r, { ok: true }))
  await page.route('**/api/android/register', (r) => json(r, { ok: true }))
  await page.route('**/api/android/log', (r) => json(r, { ok: true }))
  await page.route('**/api/android/apk/version', (r) => json(r, { manifest: null }))
  await page.route('**/api/android/commands/poll**', (r) => json(r, { commands: [] }))
  await page.route('**/lofa-config.json', (r) => json(r, { code: null }))
  await page.route('**/api/boss-sight/reviewstage/_stats', (r) => json(r, { by_status: { pending: 0 }, pushed_unread: 0 }))
  await page.route('**/api/boss-sight/residents', (r) => json(r, { residents: [] }))
  await page.route('**/api/cc/chat/sessions', (r) => json(r, { items: [{ id: 's1', kind: 'chat', provider: 'claude_code', name: '测试会话', alive: true, cwd: 'E:/x' }] }))
  await page.route('**/api/cc/chat/active', (r) => json(r, {}))
  await page.route('**/api/cc/sessions?**', (r) => json(r, { items: [], recoverable: [] }))
  await page.route('**/api/cc/sessions', (r) => json(r, { items: [], recoverable: [] }))
}

test.describe('LOFA 启动冒烟(地基)', () => {
  test('boot:无错误 / 4 tab / 默认会话 / 我的分组 / 连接页 / ambient / 玻璃≤2', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)))
    await setupRoutes(page)
    await page.goto('/')

    // 底部 4 tab 渲染
    await expect(page.locator('#bottomNav')).toHaveClass(/show/)
    await expect(page.locator('#bottomNav .lg-tab')).toHaveCount(4)

    // 默认落会话 tab
    await expect(page.locator('#sessionsView')).toHaveClass(/show/)

    // 连接成功后我的分组列表渲染(连接完成的信号:5 个分组)
    await expect(page.locator('#meList .lg-group')).toHaveCount(5)

    // ambient 背景层存在
    await expect(page.locator('#ambient')).toHaveCount(1)

    // 同屏 backdrop-filter 元素 ≤2(玻璃只在导航/浮层)
    const glassCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('*')).filter((el) => {
        const s = getComputedStyle(el)
        const bf = s.backdropFilter || s.webkitBackdropFilter || 'none'
        if (!bf || bf === 'none') return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      }).length
    })
    expect(glassCount).toBeLessThanOrEqual(2)

    // tab 可切换:审阅 → 项目 → 我的 → 会话
    await page.locator('#bottomNav .lg-tab[data-tab="review"]').click()
    await expect(page.locator('#reviewView')).toHaveClass(/show/)
    await page.locator('#bottomNav .lg-tab[data-tab="projects"]').click()
    await expect(page.locator('#projectsView')).toHaveClass(/show/)
    await page.locator('#bottomNav .lg-tab[data-tab="me"]').click()
    await expect(page.locator('#meView')).toHaveClass(/show/)

    // 连接编辑页可打开(点主机行推入)
    await page.locator('#meList [data-k="host"]').click()
    await expect(page.locator('#connectView')).toHaveClass(/show/)
    await expect(page.locator('#connectHost')).toBeVisible()

    // 返回回到我的
    await page.locator('#connectView .lg-nav-back').click()
    await expect(page.locator('#meView')).toHaveClass(/show/)

    await page.locator('#bottomNav .lg-tab[data-tab="sessions"]').click()
    await expect(page.locator('#sessionsView')).toHaveClass(/show/)

    expect(errors).toEqual([])
  })
})
