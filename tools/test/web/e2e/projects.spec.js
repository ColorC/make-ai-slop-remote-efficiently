// projects.spec — 项目只读双视图(§7f + §11e + 追加修订):
//   四段切换(应用/列表/任务/计划)、应用段真启动器(apps 宫格 + 项目宫格)、列表段分组+快速入口、
//   app 内打开网页推入(#browserView)、详情推入、只读护栏(全程只 GET)。
import { test, expect } from '@playwright/test'
import { baseRoutes, landSessions, json } from './helpers.js'

const PROJECT_VIEWS = {
  apps: [
    { id: 'walker-demo', label: '行者 demo', icon: '🎮', url: '/walker-game/' },
    { id: 'aigc', label: 'aigc 审阅', icon: '🎨', icon_url: '/api/project-assets/aigc.png', url: 'http://localhost:8077/' },
  ],
}
const PROJECTS = {
  projects: [
    { id: 'p1', name: '项目甲', group: 'omnicompany', pinned: true, plan_count: 3,
      last_active: '2026-07-16T10:00:00+00:00', desc: '甲项目一句话简介',
      bg: 'linear-gradient(135deg,#172b3e,#2b847c)', links: [{ label: '看板', url: 'http://localhost:8210/' }] },
    { id: 'p2', name: '项目乙', group: 'other', index_stale: true, stale_reason: 'index 久未核对',
      desc: '乙项目简介', bg: '/api/project-assets/p2.png', links: [] },
  ],
  groups_order: ['omnicompany', 'other'], group_labels: { omnicompany: 'Omnicompany', other: '其它' },
}
const QUESTS = { quests: [{ id: 'q1', title: '任务一', status: 'main', objective: '长期目标', active_plan_count: 2 }] }
const PLANS = { items: [{ id: 'proj/x/[2026-07-16]P', date: '2026-07-16', topic: '计划主题', category: '开发' }] }

async function setup(page) {
  const ctx = await baseRoutes(page)
  const writes = []
  page.on('request', (req) => {
    const u = req.url()
    if (/\/api\/(projects|quests|plans)/.test(u) && req.method() !== 'GET') writes.push(req.method() + ' ' + u)
  })
  await page.route(/\/api\/project-views/, (r) => json(r, PROJECT_VIEWS))
  await page.route(/\/api\/projects(\?|$)/, (r) => json(r, PROJECTS))
  await page.route(/\/api\/projects\/[^/]+\/plans/, (r) => json(r, { items: [] }))
  await page.route(/\/api\/quests(\?|$)/, (r) => json(r, QUESTS))
  await page.route(/\/api\/plans(\?|$)/, (r) => json(r, PLANS))
  return { ctx, writes }
}

async function toProjects(page) {
  await landSessions(page)
  await page.locator('#bottomNav .lg-tab[data-tab="projects"]').click()
  await expect(page.locator('#projectsView')).toHaveClass(/show/)
  await page.locator('#projectsList .proj-item').first().waitFor()
}

test.describe('项目双视图', () => {
  test('四段切换:应用 / 列表 / 任务 / 计划', async ({ page }) => {
    await setup(page)
    await toProjects(page)
    // 默认列表段:分组头 + 项目行(展示图/名/简介)
    await expect(page.locator('#projectsList .proj-group-head', { hasText: 'Omnicompany' })).toHaveCount(1)
    await expect(page.locator('#projectsList .proj-item', { hasText: '项目甲' })).toHaveCount(1)
    await expect(page.locator('#projectsList')).toContainText('甲项目一句话简介')

    // 应用段:启动器宫格(app + 项目图标)
    await page.locator('#projectsBoardSeg button[data-v="apps"]').click()
    await expect(page.locator('#projectsApps')).toBeVisible()
    await expect(page.locator('#projectsApps .proj-app', { hasText: '行者 demo' })).toHaveCount(1)
    await expect(page.locator('#projectsApps .proj-app', { hasText: '项目甲' })).toHaveCount(1)

    // 任务段
    await page.locator('#projectsBoardSeg button[data-v="quests"]').click()
    await expect(page.locator('#projectsList .lg-row', { hasText: '任务一' })).toHaveCount(1)

    // 计划段 + 筛选 sheet 项目单选
    await page.locator('#projectsBoardSeg button[data-v="plans"]').click()
    await expect(page.locator('#projectsList .lg-row', { hasText: '计划主题' })).toHaveCount(1)
    await page.locator('#projectsFilterPill').click()
    await expect(page.locator('#projectsFilterSheet .lg-sheet-radio[data-project=""]')).toContainText('全部项目')
  })

  test('应用段:pinned 项目在前, app 置顶', async ({ page }) => {
    await setup(page)
    await toProjects(page)
    await page.locator('#projectsBoardSeg button[data-v="apps"]').click()
    await expect(page.locator('#projectsApps .proj-app')).toHaveCount(4)   // 2 app + 2 项目
    const names = await page.locator('#projectsApps .proj-app .proj-app-name').allInnerTexts()
    expect(names[0]).toContain('行者 demo')  // apps 在前
    expect(names[2]).toContain('项目甲')      // 项目段 pinned 在前
    // icon_url 的 app 渲染成图标(img);无 icon_url 回退 emoji
    await expect(page.locator('#projectsApps .proj-app', { hasText: 'aigc 审阅' }).locator('.proj-app-icon')).toHaveClass(/img/)
    await expect(page.locator('#projectsApps .proj-app', { hasText: '行者 demo' }).locator('.proj-app-icon')).toHaveClass(/emoji/)
  })

  test('点击 app → app 内全屏网页(#browserView 推入, 相对路径拼 base)', async ({ page }) => {
    await setup(page)
    await toProjects(page)
    await page.locator('#projectsBoardSeg button[data-v="apps"]').click()
    await page.locator('#projectsApps .proj-app', { hasText: '行者 demo' }).click()
    await expect(page.locator('#browserView')).toHaveClass(/show/)
    await expect(page.locator('#browserView iframe')).toHaveAttribute('src', 'https://localhost:5599/walker-game/')
  })

  test('列表段快速入口:点项目 links 打开网页(localhost 主机替换)', async ({ page }) => {
    await setup(page)
    await toProjects(page)
    await page.locator('#projectsList .proj-item', { hasText: '项目甲' }).locator('.proj-link', { hasText: '看板' }).click()
    await expect(page.locator('#browserView')).toHaveClass(/show/)
    await expect(page.locator('#browserView iframe')).toHaveAttribute('src', 'http://localhost:8210/')
  })

  test('列表段分组头可折叠', async ({ page }) => {
    await setup(page)
    await toProjects(page)
    const head = page.locator('#projectsList .proj-group-head[data-group="omnicompany"]')
    await expect(page.locator('#projectsList .proj-item', { hasText: '项目甲' })).toBeVisible()
    await head.click()
    await expect(head).toHaveClass(/collapsed/)
    await expect(page.locator('#projectsList .proj-item', { hasText: '项目甲' })).toBeHidden()
  })

  test('详情推入:列表行主体 → 项目详情标题与关联计划区', async ({ page }) => {
    await setup(page)
    await toProjects(page)
    await page.locator('#projectsList .proj-item', { hasText: '项目甲' }).locator('.proj-item-main').click()
    await expect(page.locator('#projectDetailView')).toHaveClass(/show/)
    await expect(page.locator('#projectDetailView .lg-nav-title')).toHaveText('项目甲')
    await expect(page.locator('#projectDetail')).toContainText('关联计划')
  })

  test('只读护栏:全程无写请求', async ({ page }) => {
    const { writes } = await setup(page)
    await toProjects(page)
    await page.locator('#projectsBoardSeg button[data-v="apps"]').click()
    await page.locator('#projectsApps .proj-app').first().waitFor()
    await page.locator('#projectsBoardSeg button[data-v="quests"]').click()
    await page.locator('#projectsList .lg-row').first().waitFor()
    await page.locator('#projectsBoardSeg button[data-v="plans"]').click()
    await page.locator('#projectsList .lg-row').first().waitFor()
    expect(writes).toEqual([])
  })
})
