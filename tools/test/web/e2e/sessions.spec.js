// sessions.spec — 统一会话空间(§7a/§7b):两族混排分组、状态点、FAB 新建 sheet、
//   建 chat / 建 term 的 POST body、recoverable 续接流。REST 全 mock,WS 归一化。
import { test, expect } from '@playwright/test'
import { baseRoutes, installChatWs, installPtyWs, landSessions, until, json } from './helpers.js'

const now = Date.now()
// 混排样例:活跃 chat(working=running)、久前结束 chat(ended)、活跃终端(running)、可续接终端。
function mixed() {
  return {
    chatSessions: {
      items: [
        { id: 'c1', kind: 'chat', name: '活跃对话', provider: 'claude_code', cwd: 'E:/proj/alpha', alive: true, started_at: now / 1000 },
        { id: 'c2', kind: 'chat', name: '旧对话', provider: 'codex', cwd: 'E:/proj/beta', alive: false, ended_at: (now - 12 * 86400000) / 1000 },
      ],
    },
    active: { c1: 'working' },
    ptySessions: {
      items: [{ id: 'p1', cmd: ['powershell'], cwd: 'E:/proj/alpha', alive: true, working: true, last_output_at: now / 1000 }],
      recoverable: [{ id: 'r1', cmd: null, cwd: 'E:/proj/gamma', last_output_at: (now - 2 * 3600000) / 1000 }],
    },
  }
}

test.describe('会话空间', () => {
  test('两族混排:统一时间桶 + 状态点 + 可续接标', async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message || e)))
    await baseRoutes(page, mixed())
    await landSessions(page)

    // 分组小标题:统一按时间桶,今天在最前,且有「更早」桶。
    const heads = page.locator('#sessionsList .lg-sec-head')
    await expect(heads.first()).toContainText('今天')
    await expect(page.locator('#sessionsList .lg-sec-head', { hasText: '更早' })).toHaveCount(1)

    // running(chat working + 终端 working)行有「在跑」状态徽标。
    await expect(page.locator('#sessionsList .lg-row', { hasText: '活跃对话' }).locator('.lg-badge.st-seal')).toContainText('在跑')
    await expect(page.locator('#sessionsList .lg-row', { hasText: 'PowerShell' }).locator('.lg-badge.st-seal')).toContainText('在跑')

    // ended chat 落更早桶;recoverable 终端显「可续接」。
    await expect(page.locator('#sessionsList .lg-row', { hasText: '旧对话' })).toHaveCount(1)
    await expect(page.locator('#sessionsList .lg-row', { hasText: '可续接' })).toHaveCount(1)

    expect(errors).toEqual([])
  })

  test('FAB 打开新建 sheet:类型 10 项 + 继续上次(无工作目录分区)', async ({ page }) => {
    // 预置上次配置(仅记类型) → 「继续上次配置新建」大行出现。
    await baseRoutes(page, mixed())
    await page.addInitScript(() => {
      try { localStorage.setItem('lofa.lastNewSession', JSON.stringify({ typeId: 'chat_codex' })) } catch (e) {}
    })
    await landSessions(page)

    await page.locator('#fabNew').click()
    await expect(page.locator('#newSheet')).toBeVisible()
    await expect(page.locator('#newSheet .lg-sheet-big')).toContainText('继续上次配置新建')
    // 类型 10 radio 行(对话 5 + 终端 5)。
    await expect(page.locator('#newSheet .lg-sheet-radio[data-type]')).toHaveCount(10)
    // 「工作目录」分区已删除:无目录 chips。
    await expect(page.locator('#newSheet .ss-dir-chips')).toHaveCount(0)
    await expect(page.locator('#newSheet #newCreate')).toBeVisible()
  })

  test('建 chat:选 Codex 对话 → POST body 用固定 cwd 并进对话屏', async ({ page }) => {
    const ctx = await baseRoutes(page, mixed())
    const chatWs = await installChatWs(page)
    await landSessions(page)

    await page.locator('#fabNew').click()
    await page.locator('#newSheet .lg-sheet-radio[data-type="chat_codex"]').click()
    await page.locator('#newSheet #newCreate').click()

    await until(() => ctx.chatCreates.length)
    expect(ctx.chatCreates[0]).toEqual({ provider: 'codex', cwd: '' })
    await expect(page.locator('#chatView')).toHaveClass(/show/)
    await until(() => chatWs.ws)
  })

  test('建 term:选 PowerShell → POST body 用固定 cwd 并进终端屏', async ({ page }) => {
    const ctx = await baseRoutes(page, mixed())
    const ptyWs = await installPtyWs(page)
    await landSessions(page)

    await page.locator('#fabNew').click()
    await page.locator('#newSheet .lg-sheet-radio[data-type="term_shell"]').click()
    await page.locator('#newSheet #newCreate').click()

    await until(() => ctx.ptyCreates.length)
    expect(ctx.ptyCreates[0]).toEqual({ cmd: ['powershell'], cwd: '', cols: 80, rows: 24, safe_mode: false })
    await expect(page.locator('#termView')).toHaveClass(/show/)
    await until(() => ptyWs.ws)
  })

  test('新建在途态:点击变「新建中…」并禁用,失败恢复并 toast', async ({ page }) => {
    const data = mixed()
    await baseRoutes(page, data)
    // 覆盖 chat 建接口:GET 照常返回列表;POST 延迟后 500 → 触发失败恢复分支。
    await page.route(/\/api\/cc\/chat\/sessions(\?|$)/, async (r) => {
      if (r.request().method() === 'GET') return json(r, data.chatSessions)
      await new Promise((res) => setTimeout(res, 500))
      return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: '后端拒绝' }) })
    })
    await landSessions(page)

    await page.locator('#fabNew').click()
    await page.locator('#newSheet .lg-sheet-radio[data-type="chat_claude"]').click()
    await page.locator('#newSheet #newCreate').click()
    // 在途:按钮禁用 + 文案「新建中…」(sheet 不关)。
    await expect(page.locator('#newSheet #newCreate')).toBeDisabled()
    await expect(page.locator('#newSheet #newCreate')).toHaveText('新建中…')
    // 失败恢复:toast 报错 + 按钮复位可再点。
    await expect(page.locator('#toast .lg-toast')).toContainText('新建失败')
    await expect(page.locator('#newSheet #newCreate')).toBeEnabled()
    await expect(page.locator('#newSheet #newCreate')).toHaveText('新建')
  })

  test('recoverable 点击即续接:直接 POST resume → 进终端屏(无确认弹窗)', async ({ page }) => {
    const ctx = await baseRoutes(page, mixed())
    const ptyWs = await installPtyWs(page)
    let resumed = false
    await page.route(/\/api\/cc\/sessions\/r1\/resume/, (r) => {
      resumed = true
      return json(r, { id: 'r1-resumed', cmd: null, cwd: 'E:/proj/gamma', alive: true, resumed_from: 'r1', last_output_at: Date.now() / 1000 })
    })
    await landSessions(page)

    await page.locator('#sessionsList .lg-row', { hasText: '可续接' }).click()
    // §11a:无确认弹窗,点击即续接。
    await until(() => resumed)
    await expect(page.locator('.lg-modal-title')).toHaveCount(0)
    await expect(page.locator('#termView')).toHaveClass(/show/)
    await until(() => ptyWs.ws)
    void ctx
  })

  test('session deep link accepts provider id and resumes a recoverable PTY', async ({ page }) => {
    const data = mixed()
    data.ptySessions.recoverable[0].provider_session_id = 'provider-r1'
    await baseRoutes(page, data)
    const ptyWs = await installPtyWs(page)
    let resumed = false
    await page.route(/\/api\/cc\/sessions\/r1\/resume/, (r) => {
      resumed = true
      return json(r, { id: 'r1-resumed', cmd: null, cwd: 'E:/proj/gamma', alive: true, resumed_from: 'r1' })
    })
    await landSessions(page)

    const opened = await page.evaluate(() => window.LOFA.router.open('session:provider-r1'))
    expect(opened).toBe(true)
    await until(() => resumed)
    await expect(page.locator('#termView')).toHaveClass(/show/)
    await until(() => ptyWs.ws)
  })
})
