// review.spec — 审阅收件箱(§7e/§11c):分段筛选 + 筛选 sheet、详情推入、单条 verdict(mock POST)、多选批量。
//   reviewState 逻辑不动,只驱动真 UI;WS /stream mock 成空,避免真连噪声。
import { test, expect } from '@playwright/test'
import { baseRoutes, landSessions, until, json } from './helpers.js'

const MATS = [
  { id: 'm1', kind: 'markdown', title: '待审报告', tier: 'mandatory', status: 'pending', source_plan_id: 'proj/x/[2026-07-16]P', updated_at: new Date().toISOString(), inline_content: '# 报告\n这是正文内容', pushed_to_user: true },
  { id: 'm2', kind: 'markdown', title: '已过报告', tier: 'important', status: 'accepted', source_plan_id: 'proj/y/[2026-07-15]Q', updated_at: new Date().toISOString(), inline_content: '# 通过\n正文二' },
]

async function setup(page) {
  const ctx = await baseRoutes(page)
  const calls = { verdict: [], batch: [] }
  await page.route(/\/api\/boss-sight\/reviewstage\/_stats/, (r) => json(r, { by_status: { pending: 1, accepted: 1 }, by_tier: { mandatory: 1, important: 1 }, pushed_unread: 1 }))
  await page.route(/\/api\/boss-sight\/reviewstage\?/, (r) => {
    const u = new URL(r.request().url())
    const status = u.searchParams.get('status')
    const items = status ? MATS.filter((m) => m.status === status) : MATS
    return json(r, { items })
  })
  await page.route(/\/api\/boss-sight\/reviewstage\/m1\/verdict/, (r) => { calls.verdict.push(r.request().postDataJSON()); return json(r, { ok: true }) })
  await page.route(/\/api\/boss-sight\/reviewstage\/m1\/mark_pushed/, (r) => json(r, { ok: true }))
  await page.route(/\/api\/boss-sight\/reviewstage\/m1(\?|$)/, (r) => json(r, MATS[0]))
  await page.route(/\/api\/boss-sight\/reviewstage\/batch_verdict/, (r) => { const b = r.request().postDataJSON(); calls.batch.push(b); return json(r, { changed_count: (b.ids || []).length, changed_ids: b.ids }) })
  await page.routeWebSocket(/\/reviewstage\/stream$/, () => {})
  return { ctx, calls }
}

async function toReview(page) {
  await landSessions(page)
  await page.locator('#bottomNav .lg-tab[data-tab="review"]').click()
  await expect(page.locator('#reviewView')).toHaveClass(/show/)
  await page.locator('#reviewList .rv-row').first().waitFor()
}

test.describe('审阅', () => {
  test('紧凑两行头部:小标题 + 搜索图标展开整行输入框 + 段/筛选同排', async ({ page }) => {
    await setup(page)
    await toReview(page)
    // 第一行:「审阅」小标题 + 搜索/选择/刷新图标区。
    await expect(page.locator('#reviewHead .rv-head-title')).toContainText('审阅')
    await expect(page.locator('#reviewHead #reviewSelect')).toBeVisible()
    await expect(page.locator('#reviewHead #reviewRefresh')).toBeVisible()
    // 第二行:segmented + 「筛选」pill 同排(#reviewFilters)。
    await expect(page.locator('#reviewFilters #reviewSeg')).toHaveCount(1)
    await expect(page.locator('#reviewFilters #reviewFilterPill')).toHaveCount(1)
    // 搜索图标点击原地展开成整行输入框;过滤生效;再点收起并清空。
    await expect(page.locator('#reviewHead')).not.toHaveClass(/searching/)
    await page.locator('#reviewSearchBtn').click()
    await expect(page.locator('#reviewHead')).toHaveClass(/searching/)
    await page.locator('#reviewSearch').fill('待审报告')
    await expect(page.locator('#reviewList .rv-row')).toHaveCount(1)
    await page.locator('#reviewSearchBtn').click()
    await expect(page.locator('#reviewHead')).not.toHaveClass(/searching/)
    await expect(page.locator('#reviewList .rv-row', { hasText: '待审报告' })).toHaveCount(1)
  })

  test('分段筛选:待审 → 已处理 切换列表', async ({ page }) => {
    await setup(page)
    await toReview(page)
    // 默认待审:显 m1(pending)不显 m2(accepted)。
    await expect(page.locator('#reviewList .rv-row', { hasText: '待审报告' })).toHaveCount(1)
    await expect(page.locator('#reviewList .rv-row', { hasText: '已过报告' })).toHaveCount(0)
    // 切到「已处理」(accepted+rejected+blocked):m2 出现,m1 隐去。
    await page.locator('#reviewSeg button[data-v="processed"]').click()
    await expect(page.locator('#reviewSeg button[data-v="processed"]')).toHaveClass(/on/)
    await expect(page.locator('#reviewList .rv-row', { hasText: '已过报告' })).toHaveCount(1)
    await expect(page.locator('#reviewList .rv-row', { hasText: '待审报告' })).toHaveCount(0)
  })

  test('筛选 pill:层级单选 sheet + 生效角标', async ({ page }) => {
    await setup(page)
    await toReview(page)
    await page.locator('#reviewFilterPill').click()
    await expect(page.locator('#reviewFilterSheet')).toBeVisible()
    // 层级单选「强制」→ pill 出现生效角标 1。
    await page.locator('#reviewFilterSheet .lg-sheet-radio[data-tier="mandatory"]').click()
    await expect(page.locator('#reviewFilterSheet .lg-sheet-radio[data-tier="mandatory"]')).toHaveClass(/on/)
    await expect(page.locator('#reviewFilterPill .rv-filter-badge')).toHaveText('1')
    // 清除 → 角标消失。
    await page.locator('#reviewFilterClear').click()
    await expect(page.locator('#reviewFilterPill .rv-filter-badge')).toHaveCount(0)
  })

  test('详情推入 + 单条 verdict(POST)', async ({ page }) => {
    const { calls } = await setup(page)
    await toReview(page)
    await page.locator('#reviewList .rv-row', { hasText: '待审报告' }).click()
    await expect(page.locator('#reviewDetailView')).toHaveClass(/show/)
    await expect(page.locator('#reviewDetailTitle')).toHaveText('待审报告')
    await expect(page.locator('#reviewDetailBody #rvContent')).toContainText('这是正文内容')

    // 内容优先材料默认沉浸；先用悬浮手柄召回审阅工具，再裁决。
    await expect(page.locator('#reviewChromeHandle')).toBeVisible()
    await page.locator('#reviewChromeHandle').click()
    await expect(page.locator('#reviewDetailView')).not.toHaveClass(/rv-immersive/)
    await page.locator('#reviewDetailBar [data-v="accepted"]').click()
    await until(() => calls.verdict.length)
    expect(calls.verdict[0].verdict).toBe('accepted')
    await expect(page.locator('#toast .lg-toast')).toContainText('已通过')
  })

  test('多选批量:选择 → 全选 → 批量通过(POST)', async ({ page }) => {
    const { calls } = await setup(page)
    await toReview(page)
    // 进入选择模式(紧凑头部「选择」文字钮)。
    await page.locator('#reviewSelect').click()
    await expect(page.locator('#reviewList .rv-row .rv-cb').first()).toBeVisible()
    // 选一行 → 底部操作条出现。
    await page.locator('#reviewList .rv-row', { hasText: '待审报告' }).click()
    await expect(page.locator('#reviewActions')).toHaveClass(/show/)
    await expect(page.locator('#reviewActions')).toContainText('已选 1')
    // 批量通过 → 确认弹窗 → ok。
    await page.locator('#reviewActions [data-v="accepted"]').click()
    await expect(page.locator('.lg-modal-title')).toContainText('批量通过')
    await page.locator('.lg-modal-ok').click()
    await until(() => calls.batch.length)
    expect(calls.batch[0].verdict).toBe('accepted')
    expect(calls.batch[0].ids).toContain('m1')
  })
})
