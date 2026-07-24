// nav.spec — 导航栈(§4b/§9):tab 切换、push/pop、返回优先级(开 sheet 时 back 关 sheet 不退页)、
//   深链 router.open(tab / session:<id> / review:<id>)。router.back() 是统一返回入口。
import { test, expect } from '@playwright/test'
import { baseRoutes, installChatWs, landSessions, json } from './helpers.js'

const REVIEW_MAT = { id: 'm1', kind: 'markdown', title: '深链报告', tier: 'important', status: 'pending', inline_content: '# 深链\n正文', updated_at: new Date().toISOString() }

async function setupReview(page, ctx) {
  await page.route(/\/api\/boss-sight\/reviewstage\?/, (r) => json(r, { items: [REVIEW_MAT] }))
  await page.route(/\/api\/boss-sight\/reviewstage\/m1(\?|$)/, (r) => json(r, REVIEW_MAT))
  await page.route(/\/api\/boss-sight\/reviewstage\/m1\/mark_pushed/, (r) => json(r, { ok: true }))
  await page.routeWebSocket(/\/reviewstage\/stream$/, () => {})
  void ctx
}

test.describe('导航栈', () => {
  test('底 tab 切换:视图与选中态跟随', async ({ page }) => {
    const ctx = await baseRoutes(page)
    await setupReview(page, ctx)
    await landSessions(page)

    await page.locator('#bottomNav .lg-tab[data-tab="review"]').click()
    await expect(page.locator('#reviewView')).toHaveClass(/show/)
    await expect(page.locator('#bottomNav .lg-tab[data-tab="review"]')).toHaveClass(/on/)

    await page.locator('#bottomNav .lg-tab[data-tab="projects"]').click()
    await expect(page.locator('#projectsView')).toHaveClass(/show/)
    await page.locator('#bottomNav .lg-tab[data-tab="me"]').click()
    await expect(page.locator('#meView')).toHaveClass(/show/)
  })

  test('push/pop:进对话屏隐藏底 tab,返回复原', async ({ page }) => {
    const ctx = await baseRoutes(page)
    await installChatWs(page)
    ctx.chatSessions = { items: [{ id: 'c1', kind: 'chat', name: '会话一', provider: 'claude_code', cwd: 'E:/p', alive: true, started_at: Date.now() / 1000 }] }
    await landSessions(page)

    await expect(page.locator('#bottomNav')).toHaveClass(/show/)
    await page.locator('#sessionsList .lg-row').first().click()
    await expect(page.locator('#chatView')).toHaveClass(/show/)
    await expect(page.locator('#bottomNav')).not.toHaveClass(/show/)   // 推入页隐藏底 tab

    await page.locator('#chatView .lg-nav-back').click()
    await expect(page.locator('#sessionsView')).toHaveClass(/show/)
    await expect(page.locator('#bottomNav')).toHaveClass(/show/)
  })

  test('返回优先级:开 sheet 时 back 只关 sheet 不退页', async ({ page }) => {
    await baseRoutes(page)
    await landSessions(page)
    await page.locator('#fabNew').click()
    await expect(page.locator('#newSheet')).toBeVisible()

    const handled = await page.evaluate(() => window.LOFA.router.back())
    expect(handled).toBe(true)
    await expect(page.locator('#newSheet')).toHaveCount(0)
    await expect(page.locator('#sessionsView')).toHaveClass(/show/)   // 仍在会话页,未退
  })

  test('返回优先级:非默认 tab back 回默认 tab;默认根页 back 返回 false', async ({ page }) => {
    const ctx = await baseRoutes(page)
    await setupReview(page, ctx)
    await landSessions(page)

    await page.locator('#bottomNav .lg-tab[data-tab="review"]').click()
    await expect(page.locator('#reviewView')).toHaveClass(/show/)
    const back1 = await page.evaluate(() => window.LOFA.router.back())
    expect(back1).toBe(true)
    await expect(page.locator('#sessionsView')).toHaveClass(/show/)

    const back2 = await page.evaluate(() => window.LOFA.router.back())
    expect(back2).toBe(false)   // 默认 tab 根页无处可退(交调用方最小化)
  })

  test('深链:open(tab) / open(session:id) / open(review:id)', async ({ page }) => {
    const ctx = await baseRoutes(page)
    await setupReview(page, ctx)
    await landSessions(page)

    await page.evaluate(() => window.LOFA.router.open('projects'))
    await expect(page.locator('#projectsView')).toHaveClass(/show/)

    await page.evaluate(() => window.LOFA.router.open('session:c1'))
    await expect(page.locator('#sessionsView')).toHaveClass(/show/)

    await page.evaluate(() => window.LOFA.router.open('review:m1'))
    await expect(page.locator('#reviewView')).toHaveClass(/show/)
    await expect(page.locator('#reviewDetailView')).toHaveClass(/show/)   // 深链推入详情
    await expect(page.locator('#reviewDetailTitle')).toHaveText('深链报告')
  })
})
