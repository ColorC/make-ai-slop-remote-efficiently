// term.spec — 终端屏(§7d):snapshot 重画出现文本、附加键条(Tab / Ctrl 粘滞组合 / 键盘 Ctrl+C)
//   往 WS 发正确 input 序列、exit 覆盖层出现。PTY WS 用 routeWebSocket mock。
import { test, expect } from '@playwright/test'
import { baseRoutes, installPtyWs, until, push } from './helpers.js'

async function openTerm(page) {
  const ctx = await baseRoutes(page)
  const ws = await installPtyWs(page)
  ctx.ptySessions = { items: [{ id: 'p1', cmd: ['powershell'], cwd: 'E:/proj', alive: true, last_output_at: Date.now() / 1000 }], recoverable: [] }
  await page.goto('/')
  await page.locator('#sessionsList .lg-row').first().waitFor()
  await page.locator('#sessionsList .lg-row').first().click()
  await expect(page.locator('#termView')).toHaveClass(/show/)
  await until(() => ws.ws)
  return { ctx, ws }
}

test.describe('终端屏', () => {
  test('snapshot 重画出现文本', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: ['snapshot-marker-42\r\n'] })
    // WebGL 渲染器把文本画进 canvas(DOM 无文字),断言走 xterm buffer 才是真端到端
    await until(() => page.evaluate(() => {
      const t = window.__lofaTerm; if (!t) return false
      const b = t.buffer.active
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString().includes('snapshot-marker-42')) return true }
      return false
    }))
    // 覆盖层在 snapshot 后收起。
    await expect(page.locator('#termView .term-overlay')).not.toHaveClass(/show/)
  })

  test('附加键条:默认隐藏,⌨ 钉住后 Tab / Esc / 方向键 → 正确序列', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })

    // 键条默认收起(不常驻占屏),右下 ⌨ 浮钮召出
    await expect(page.locator('#termKeys')).not.toBeVisible()
    await page.locator('#termView .term-kfab').click()
    await expect(page.locator('#termKeys')).toBeVisible()

    await page.locator('#termKeys .term-key[data-key="Tab"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\t'))

    await page.locator('#termKeys .term-key[data-key="Esc"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b'))

    await page.locator('#termKeys .term-key[data-key="ArrowUp"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b[A'))
  })

  test('附加键条:Ctrl 粘滞 + 方向键 → CSI 修饰序列', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await page.locator('#termView .term-kfab').click()   // 先召出键条
    // 点亮 Ctrl(点=armed),下一个方向键组合发送。
    await page.locator('#termKeys .term-key[data-mod="ctrl"]').click()
    await expect(page.locator('#termKeys .term-key[data-mod="ctrl"]')).toHaveClass(/armed/)
    await page.locator('#termKeys .term-key[data-key="ArrowUp"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b[1;5A'))
  })

  test('终端键盘 Ctrl+C → \\x03 上行', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await page.locator('#termScreen .xterm-helper-textarea').focus()
    await page.keyboard.press('Control+C')
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x03'))
  })

  test('exit → 覆盖层出现并可回列表', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await push(ws, { type: 'exit', reason: 'process exited' })
    await expect(page.locator('#termView .term-overlay')).toHaveClass(/show/)
    await expect(page.locator('#termView .term-overlay')).toContainText('会话已结束')
    await expect(page.locator('#termView .term-overlay .lg-btn')).toContainText('回列表')
  })
})
