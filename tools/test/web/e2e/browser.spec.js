import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5599/test-remote'

async function setupRoutes(page) {
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  await page.route('**/api/healthz', (route) => json(route, { ok: true }))
  await page.route('**/api/android/register', (route) => json(route, { ok: true }))
  await page.route('**/api/android/log', (route) => json(route, { ok: true }))
  await page.route('**/api/android/apk/version', (route) => json(route, { manifest: null }))
  await page.route('**/api/android/commands/poll**', (route) => json(route, { commands: [] }))
  await page.route('**/lofa-config.json', (route) => json(route, { code: null }))
  await page.route('**/api/boss-sight/reviewstage/_stats', (route) => json(route, { by_status: { pending: 0 }, pushed_unread: 0 }))
  await page.route('**/api/boss-sight/residents', (route) => json(route, { residents: [] }))
  await page.route('**/api/cc/chat/sessions', (route) => json(route, { items: [] }))
  await page.route('**/api/cc/chat/active', (route) => json(route, {}))
  await page.route('**/api/cc/sessions**', (route) => json(route, { items: [], recoverable: [] }))

  await page.route('**/test-remote/', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><html><head><title>Remote home</title></head><body>
      <input id="keep" value="preserved state">
      <a id="open-child" href="/test-remote/child.html" target="_blank">Open child</a>
    </body></html>`,
  }))
  await page.route('**/test-remote/child.html', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><title>Child page</title></head><body><h1 id="child">Child page</h1></body></html>',
  }))
}

test('remote web uses full-width Dashboard tabs and keeps target=_blank inside LOFA', async ({ page, context }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error && error.message || error)))
  await setupRoutes(page)
  await page.goto('/')
  await page.locator('#browserView').waitFor({ state: 'attached' })
  await page.evaluate(async (base) => {
    const core = await import('/js/core.js')
    const browser = await import('/js/browserView.js')
    core.store.base = base
    await browser.openHome()
  }, BASE)

  await expect(page.locator('#browserView')).toHaveClass(/show/)
  await expect(page.locator('.browser-tab')).toHaveCount(1)
  await expect(page.frameLocator('.browser-frame.active').locator('#keep')).toHaveValue('preserved state')
  await expect(page.locator('#bottomNav')).not.toHaveClass(/show/)
  await expect.poll(() => page.locator('#app').evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('0px')

  await page.frameLocator('.browser-frame.active').locator('#open-child').click()

  await expect(page.locator('.browser-tab')).toHaveCount(2)
  await expect(page.frameLocator('.browser-frame.active').locator('#child')).toHaveText('Child page')
  expect(context.pages()).toHaveLength(1)

  await page.locator('.browser-tab').first().click()
  await expect(page.frameLocator('.browser-frame.active').locator('#keep')).toHaveValue('preserved state')

  await page.locator('.browser-tab').nth(1).click()
  await page.locator('.browser-tab.active .browser-tab-close').click()
  await expect(page.locator('.browser-tab')).toHaveCount(1)
  await expect(page.frameLocator('.browser-frame.active').locator('#keep')).toHaveValue('preserved state')
  expect(errors).toEqual([])
})
