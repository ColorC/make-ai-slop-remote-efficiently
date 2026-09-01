import { test, expect } from '@playwright/test'

const BASE = 'https://localhost:5599'

async function setupRoutes(page) {
  await page.addInitScript((base) => {
    try {
      localStorage.setItem('lofa.baseUrl', base)
      // A persisted migration-era flag must not restore retired local UI.
      localStorage.setItem('lofa.legacyBusinessUi', '1')
    } catch (error) {}
  }, BASE)
  const json = (route, body) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(body),
  })
  await page.route('**/api/healthz', (route) => json(route, { ok: true }))
  await page.route('**/api/android/register', (route) => json(route, { ok: true }))
  await page.route('**/api/android/log', (route) => json(route, { ok: true }))
  await page.route('**/api/android/apk/version', (route) => json(route, { manifest: null }))
  await page.route('**/api/android/commands/poll**', (route) => json(route, { commands: [] }))
}

test('cold boot always enters the current Dashboard and exposes only shell settings', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error && error.message || error)))
  await setupRoutes(page)
  await page.goto('/')

  await expect(page.locator('#viewport > .view')).toHaveCount(3)
  await expect(page.locator('#bottomNav')).toHaveCount(0)
  await expect(page.locator('#sessionsView, #chatView, #termView, #reviewView, #projectsView, #notesView')).toHaveCount(0)
  await expect(page.locator('#browserView')).toHaveClass(/show/)
  await expect(page.locator('#browserView iframe')).toHaveAttribute('src', BASE + '/?lofaRemoteWeb=1&client=lofa')

  await page.locator('#browserView [data-browser-action="settings"]').click()
  await expect(page.locator('#meView')).toHaveClass(/show/)
  await expect(page.locator('#meList .lg-group')).toHaveCount(4)
  await expect(page.locator('#meList')).not.toContainText('终端')
  await expect(page.locator('#meList')).not.toContainText('笔记')

  await page.locator('#meList [data-k="host"]').click()
  await expect(page.locator('#connectView')).toHaveClass(/show/)
  await expect(page.locator('#connectHost')).toBeVisible()
  expect(errors).toEqual([])
})
