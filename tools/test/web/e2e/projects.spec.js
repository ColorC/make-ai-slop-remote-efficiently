// Playwright 项目流程(M3) — 驱动真实 app/www 页面, REST 全 mock(只读)。
// 覆盖 test_strategy: 进 Projects→加载项目列表→切换任务卡→筛选状态→打开计划摘要/任务详情→
//   状态徽标与 fixture 一致。三个工作板同一数据源(/api/projects · /api/quests · /api/plans)。
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5599'

const PROJECTS = {
  projects: [
    { id: 'lofa', name: 'LOFA', group: 'omnicompany', pinned: true, plan_count: 2,
      last_active: '2026-06-27T08:00:00+00:00', index_stale: false,
      threads: [{ name: '壳', status: 'active', status_ok: true }], activity_7d: [false, true] },
    { id: 'stale1', name: '陈旧项目', group: 'other', plan_count: 0,
      last_active: '2026-01-01T00:00:00+00:00', index_stale: true, stale_reason: 'index 久未核对', threads: [] },
  ],
  groups_order: ['omnicompany', 'other'], group_labels: {},
}
const QUESTS = {
  quests: [
    { id: 'lofa', title: 'LOFA', status: 'main', group: 'omnicompany', objective: '局域网远看 omnicompany',
      chapter: '接入项目工作板', sub_objectives: [{ id: 'lofa/[2026-06-20]SHELL', title: '移动壳', date: '2026-06-20' }],
      active_plan_count: 1, last_active: '2026-06-27T08:00:00+00:00' },
  ],
}
const PLANS = {
  items: [
    { id: 'igame/[2026-06-01]X', topic: 'X', date: '2026-06-01', category: 'igame', archived: false, title_zh: '某计划' },
    { id: '_archive/[2026-05-01]OLD', topic: 'OLD', date: '2026-05-01', category: '_archive', archived: true },
  ], total: 2,
}
const LOFA_PLANS = {
  project: 'lofa',
  items: [{ id: 'lofa/[2026-06-20]SHELL', topic: 'SHELL', title_zh: '移动壳计划', date: '2026-06-20', category: 'lofa', archived: false }],
  plan_ids: ['lofa/[2026-06-20]SHELL'],
}
// 真后端 get_plan(plans.py) 不返回 category(仅 id/topic/date/folder_path/files/archived/meta)。
const PLAN_DETAIL = {
  id: 'igame/[2026-06-01]X', topic: 'X', date: '2026-06-01',
  folder_path: 'docs/plans/igame/[2026-06-01]X', archived: false,
  files: [{ path: 'plan.md', is_md: true, summary: '这是计划摘要文本' }], meta: { status: 'active', work_type: 'planning' },
}

async function setupRoutes(page) {
  await page.addInitScript((base) => { try { localStorage.setItem('lofa.baseUrl', base) } catch (e) {} }, BASE)
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  // 壳 / 连接 / 轮询
  await page.route('**/api/healthz', (r) => json(r, { ok: true }))
  await page.route('**/api/android/register', (r) => json(r, { ok: true }))
  await page.route('**/api/android/log', (r) => json(r, { ok: true }))
  await page.route('**/api/android/apk/version', (r) => json(r, { manifest: null }))
  await page.route('**/api/boss-sight/reviewstage/_stats', (r) => json(r, { by_status: { pending: 0 }, pushed_unread: 0 }))
  await page.route('**/api/boss-sight/residents', (r) => json(r, { residents: [] }))
  await page.route('**/api/boss-sight/reviewstage?*', (r) => json(r, { items: [] }))

  // ── 项目/任务/计划 只读端点 ──
  // 注: Playwright 按注册的「逆序」匹配 → 更具体的端点必须后注册(才会先被命中)。
  await page.route('**/api/quests**', (r) => json(r, QUESTS))
  await page.route('**/api/projects**', (r) => json(r, PROJECTS))           // 通用(列表)
  await page.route('**/api/projects/*/plans', (r) => json(r, LOFA_PLANS))   // 具体(项目关联计划)
  await page.route('**/api/plans**', (r) => json(r, PLANS))                 // 通用(计划列表)
  await page.route('**/api/plans/**', (r) => json(r, PLAN_DETAIL))          // 具体(计划详情, 带 id)
}

async function gotoProjects(page) {
  await page.goto('/')
  await expect(page.locator('#dot')).toHaveClass(/ok/, { timeout: 8000 })
  await page.locator('#tabProjects').click()
  await expect(page.locator('#projectsView')).toHaveClass(/show/)
}

test.describe('LOFA 项目流程(M3)', () => {
  test.beforeEach(async ({ page }) => { await setupRoutes(page) })

  test('项目列表→切任务卡→筛选→打开计划/任务详情, 状态徽标与 fixture 一致', async ({ page }) => {
    await gotoProjects(page)

    // 1) 默认项目板: 两张项目卡, 置顶 LOFA + stale 项目带「待核对」
    await expect(page.locator('#projectsList .card')).toHaveCount(2)
    await expect(page.locator('#projectsList .card', { hasText: 'LOFA' })).toBeVisible()
    await expect(page.locator('#projectsList')).toContainText('📌')
    await expect(page.locator('#projectsList .b.pst-stale')).toContainText('待核对')

    // 2) 项目状态筛选「待核对」→ 只剩 stale 项目
    await page.locator('.chip.st[data-s="stale"]').click()
    await expect(page.locator('#projectsList .card')).toHaveCount(1)
    await expect(page.locator('#projectsList .card')).toContainText('陈旧项目')

    // 3) 切到任务板: 主线徽标 + 长期目标
    await page.locator('.chip[data-b="quests"]').click()
    await expect(page.locator('#projectsList .b.pst-main')).toContainText('主线')
    await expect(page.locator('#projectsList')).toContainText('局域网远看 omnicompany')

    // 4) 打开任务详情: 长期目标/当前章节/子目标
    await page.locator('#projectsList .card', { hasText: 'LOFA' }).click()
    await expect(page.locator('#projectDetailView')).toHaveClass(/show/)
    await expect(page.locator('#projectDetail')).toContainText('接入项目工作板')
    await expect(page.locator('#projectDetail')).toContainText('移动壳')

    // 5) 返回 → 切计划板: 项目筛选 chips + 状态筛选「已归档」
    await page.locator('#btnBack').click()
    await page.locator('.chip[data-b="plans"]').click()
    await expect(page.locator('#projectsList .card')).toHaveCount(2)
    await expect(page.locator('.chip.pj[data-p="lofa"]')).toBeVisible()
    await page.locator('.chip.st[data-s="archived"]').click()
    await expect(page.locator('#projectsList .card')).toHaveCount(1)
    await expect(page.locator('#projectsList .b.pst-archived')).toContainText('已归档')

    // 6) 回到全部, 打开计划摘要详情(只读)
    await page.locator('.chip.st[data-s=""]').click()
    await page.locator('#projectsList .card', { hasText: '某计划' }).click()
    await expect(page.locator('#projectDetailView')).toHaveClass(/show/)
    await expect(page.locator('#projectDetail')).toContainText('这是计划摘要文本')
  })

  test('计划板选具体项目走 /projects/{id}/plans', async ({ page }) => {
    await gotoProjects(page)
    await page.locator('.chip[data-b="plans"]').click()
    await expect(page.locator('.chip.pj[data-p="lofa"]')).toBeVisible()
    const [req] = await Promise.all([
      page.waitForRequest('**/api/projects/lofa/plans'),
      page.locator('.chip.pj[data-p="lofa"]').click(),
    ])
    expect(req.url()).toContain('/api/projects/lofa/plans')
    await expect(page.locator('#projectsList .card', { hasText: '移动壳计划' })).toBeVisible()
  })

  test('顶栏刷新带 ?fresh=1 穿透服务端 index 缓存', async ({ page }) => {
    await gotoProjects(page)
    await expect(page.locator('#projectsList .card')).toHaveCount(2)
    // 点顶栏刷新 → 下一次 /api/projects 必须带 fresh=1(穿透 enrich_projects 的 _INDEX_CACHE)
    const [req] = await Promise.all([
      page.waitForRequest((r) => /\/api\/projects(\?|$)/.test(r.url()) && r.url().includes('fresh=1')),
      page.locator('#btnRefresh').click(),
    ])
    expect(req.url()).toContain('fresh=1')
    await expect(page.locator('#projectsList .card')).toHaveCount(2)
  })

  test('零写断言: 浏览全流程无任何非-GET 业务请求(真浏览器层统计)', async ({ page }) => {
    const writes = []
    page.on('request', (r) => {
      const u = r.url(), m = r.method()
      if (m === 'GET') return
      // 日志回传 / 注册 / healthz 探活属壳基础设施, 不计入项目板的写
      if (u.includes('/api/android/') || u.includes('/api/healthz')) return
      writes.push(m + ' ' + u)
    })
    await gotoProjects(page)
    await expect(page.locator('#projectsList .card')).toHaveCount(2)
    // 切板 + 状态筛选 + 项目筛选 + 开详情 + 顶栏刷新, 覆盖全部交互
    await page.locator('.chip[data-b="quests"]').click()
    await expect(page.locator('#projectsList .b.pst-main')).toBeVisible()
    await page.locator('#projectsList .card', { hasText: 'LOFA' }).click()
    await expect(page.locator('#projectDetailView')).toHaveClass(/show/)
    await page.locator('#btnBack').click()
    await page.locator('.chip[data-b="plans"]').click()
    await expect(page.locator('.chip.pj[data-p="lofa"]')).toBeVisible()
    await page.locator('.chip.pj[data-p="lofa"]').click()
    await expect(page.locator('#projectsList .card', { hasText: '移动壳计划' })).toBeVisible()
    await page.locator('#btnRefresh').click()
    await page.waitForTimeout(300)
    expect(writes).toEqual([])
  })
})
