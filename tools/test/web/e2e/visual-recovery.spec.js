// 事故恢复视觉门禁：以 TRIFORM V2 蓝图 wave4/5 的材质裁决为真源，
// 在完全 mock 的 API/PTY 上覆盖手机与平板关键页，避免网关鉴权状态污染截图。
import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { baseRoutes, installPtyWs, json, landSessions, push, until } from './helpers.js'

const OUT = process.env.LOFA_VISUAL_OUT || ''
const now = Date.now()

const sessionData = {
  chatSessions: {
    items: [
      { id: 'c1', kind: 'chat', name: 'Omnicompany 恢复验收', provider: 'claude_code', cwd: 'E:/WindowsWorkspace/omnicompany', alive: true, started_at: now / 1000 },
      { id: 'c2', kind: 'chat', name: '蓝图视觉基准复核', provider: 'codex', cwd: 'E:/WindowsWorkspace/lofa', alive: false, ended_at: (now - 86400000) / 1000 },
    ],
  },
  active: { c1: 'working' },
  ptySessions: {
    items: [{ id: 'p1', cmd: ['powershell'], cwd: 'E:/WindowsWorkspace', alive: true, working: true, last_output_at: now / 1000 }],
    recoverable: [{ id: 'r1', cmd: null, cwd: 'E:/WindowsWorkspace/lofa', last_output_at: (now - 7200000) / 1000 }],
  },
}

const materials = [
  {
    id: 'm1', kind: 'markdown', title: '恢复验收报告', tier: 'mandatory', status: 'pending',
    source_plan_id: 'frontend-design/[2026-07-18]TRIFORM-UX-REDESIGN-V2', updated_at: new Date(now).toISOString(),
    inline_content: '# 蓝图视觉验收\n\n统一网格、描图纸与按需交互均应保留。', pushed_to_user: true,
  },
  {
    id: 'm2', kind: 'markdown', title: 'LOFA 终端复测', tier: 'important', status: 'pending',
    source_plan_id: 'lofa/recovery', updated_at: new Date(now - 3600000).toISOString(),
    inline_content: '# 终端\n\n验证触控、字形与恢复。',
  },
]

async function setup(page) {
  const ctx = await baseRoutes(page, sessionData)
  const pty = await installPtyWs(page)
  await page.route(/\/api\/boss-sight\/reviewstage\/_stats/, (r) => json(r, { by_status: { pending: 2 }, by_tier: { mandatory: 1, important: 1 }, pushed_unread: 1 }))
  await page.route(/\/api\/boss-sight\/reviewstage\?/, (r) => json(r, { items: materials }))
  await page.route(/\/api\/boss-sight\/reviewstage\/m1\/mark_pushed/, (r) => json(r, { ok: true }))
  await page.route(/\/api\/boss-sight\/reviewstage\/m1(\?|$)/, (r) => json(r, materials[0]))
  await page.routeWebSocket(/\/reviewstage\/stream$/, () => {})
  return { ctx, pty }
}

async function shot(page, form, view) {
  if (!OUT) return
  await mkdir(OUT, { recursive: true })
  await page.screenshot({ path: join(OUT, `lofa-${form}-${view}.png`) })
}

async function assertBlueprintScene(page) {
  const probe = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const ambient = getComputedStyle(document.querySelector('#ambient'))
    const shown = getComputedStyle(document.querySelector('.view.show'))
    return {
      scene: root.getPropertyValue('--bp-scene').trim(),
      glass: root.getPropertyValue('--bp-glass-fill').replace(/\s+/g, ''),
      ambientPosition: ambient.position,
      ambientGrid: ambient.backgroundImage.includes('repeating-linear-gradient'),
      viewBackground: shown.backgroundColor,
    }
  })
  expect(probe).toEqual({
    scene: '#091a3e',
    glass: 'rgba(19,49,99,.58)',
    ambientPosition: 'fixed',
    ambientGrid: true,
    viewBackground: 'rgba(0, 0, 0, 0)',
  })
}

for (const [form, width, height] of [
  ['phone', 390, 844],
  ['tablet-port', 834, 1194],
  ['tablet-land', 1194, 834],
]) {
  test(`${form}: sessions/review/me/terminal 保持蓝图主题与响应式壳层`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    const { pty } = await setup(page)
    await landSessions(page)

    await assertBlueprintScene(page)
    await expect(page.locator('#sessionsView .bp-ruler-top')).toHaveCount(1)
    await shot(page, form, 'sessions')

    await page.locator('#bottomNav .lg-tab[data-tab="review"]').click()
    await page.locator('#reviewList .rv-row').first().waitFor()
    await shot(page, form, 'review')
    await page.locator('#reviewList .rv-row').first().click()
    await expect(page.locator('#reviewDetailView')).toHaveClass(/show/)
    if (width >= 840) {
      await expect(page.locator('body')).toHaveClass(/split-active/)
      const masterBg = await page.locator('#reviewView.split-master').evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(masterBg).toBe('rgba(9, 26, 62, 0.45)')
    } else {
      await expect(page.locator('#reviewView')).not.toHaveClass(/show/)
    }
    await shot(page, form, 'review-detail')

    // 手机与 834px 竖板仍是单列 push，详情打开时底栏按交互约定隐藏。
    if (width < 840) {
      await page.locator('#reviewDetailView .lg-nav-back').click()
      await expect(page.locator('#bottomNav')).toHaveClass(/show/)
    }

    await page.locator('#bottomNav .lg-tab[data-tab="me"]').click()
    await expect(page.locator('#meView')).toHaveClass(/show/)
    await expect(page.locator('#meList .lg-group')).toHaveCount(5)
    await shot(page, form, 'me')

    await page.locator('#bottomNav .lg-tab[data-tab="sessions"]').click()
    await page.locator('#sessionsList .lg-row', { hasText: 'PowerShell' }).click()
    await expect(page.locator('#termView')).toHaveClass(/show/)
    await expect(page.locator('#sessionsView')).not.toHaveClass(/show/)
    await until(() => pty.ws)
    await push(pty, { type: 'snapshot', chunks: ['LOFA recovery terminal\r\n', '\u4e2d\u6587\u5b57\u5f62 \u250c\u2500\u2510 \u2713\r\n'] })
    await until(() => page.evaluate(() => {
      const term = window.__lofaTerm
      if (!term) return false
      const buffer = term.buffer.active
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i)
        if (line && line.translateToString().includes('中文字形')) return true
      }
      return false
    }))
    await shot(page, form, 'terminal')
  })
}
