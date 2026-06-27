// projectsState 适配层单测 — 锁住"端点选择 / 状态徽标映射 / 筛选 / 卡片归一"。
// 纯函数, node 环境即可(无 DOM)。对齐已核实后端:
//   项目 GET /api/projects(enrich_projects) · 任务 GET /api/quests(build_quests)
//   计划 GET /api/plans · GET /api/projects/{id}/plans
import { describe, it, expect } from 'vitest'
import {
  BOARDS, DEFAULT_BOARD, isBoard,
  STATUS_FILTERS, statusFilters, statusMeta,
  encPath, shortTime,
  listPath, planDetailPath, projectPlansPath, extractItems, projectFilterOptions,
  projectCard, questCard, planCard, normalizeCards, filterByStatus,
} from '../../../../app/www/js/projectsState.js'

describe('工作板', () => {
  it('三个板: projects / quests / plans, 默认 projects', () => {
    expect(BOARDS.map((b) => b.value)).toEqual(['projects', 'quests', 'plans'])
    expect(DEFAULT_BOARD).toBe('projects')
  })
  it('isBoard 只认已知板', () => {
    expect(isBoard('plans')).toBe(true)
    expect(isBoard('poof')).toBe(false)
  })
})

describe('状态筛选项(按板)', () => {
  it('项目=活跃/待核对, 任务=主线/支线, 计划=进行中/已归档, 都带"全部"', () => {
    expect(STATUS_FILTERS.projects.map((f) => f[0])).toEqual(['', 'active', 'stale'])
    expect(STATUS_FILTERS.quests.map((f) => f[0])).toEqual(['', 'main', 'side'])
    expect(STATUS_FILTERS.plans.map((f) => f[0])).toEqual(['', 'active', 'archived'])
  })
  it('statusFilters 未知板退回 projects', () => {
    expect(statusFilters('poof')).toBe(STATUS_FILTERS.projects)
  })
})

describe('状态徽标映射(label + css class, 对齐电脑端语义)', () => {
  it('工作线状态', () => {
    expect(statusMeta('active')).toMatchObject({ label: '进行中', cls: 'pst-active' })
    expect(statusMeta('done')).toMatchObject({ label: '已完成', cls: 'pst-done' })
    expect(statusMeta('blocked')).toMatchObject({ label: '受阻', cls: 'pst-blocked' })
    expect(statusMeta('parked')).toMatchObject({ label: '搁置', cls: 'pst-parked' })
  })
  it('任务/计划/项目聚合状态', () => {
    expect(statusMeta('main')).toMatchObject({ label: '主线', cls: 'pst-main' })
    expect(statusMeta('side')).toMatchObject({ label: '支线', cls: 'pst-side' })
    expect(statusMeta('archived')).toMatchObject({ label: '已归档', cls: 'pst-archived' })
    expect(statusMeta('stale')).toMatchObject({ label: '待核对', cls: 'pst-stale' })
  })
  it('大小写不敏感; 未知状态原样透出 + pst-unknown', () => {
    expect(statusMeta('ACTIVE')).toMatchObject({ label: '进行中', cls: 'pst-active' })
    expect(statusMeta('weird')).toMatchObject({ label: 'weird', cls: 'pst-unknown' })
    expect(statusMeta(null)).toMatchObject({ label: '', cls: 'pst-unknown' })
  })
})

describe('小工具', () => {
  it('encPath 分段编码保留斜杠(打得到 {plan_id:path})', () => {
    expect(encPath('igame/figma-to-prefab/[2026-06-01]X Y')).toBe('igame/figma-to-prefab/%5B2026-06-01%5DX%20Y')
    expect(encPath('a/b')).toBe('a/b')
    expect(encPath(null)).toBe('')
  })
  it('shortTime 截到分钟; 空值给空串', () => {
    expect(shortTime('2026-06-27T13:45:12+00:00')).toBe('2026-06-27 13:45')
    expect(shortTime(null)).toBe('')
  })
})

describe('端点选择(筛选逻辑核心)', () => {
  it('项目板: /api/projects, fresh 加 ?fresh=1', () => {
    expect(listPath('projects', {})).toBe('/api/projects')
    expect(listPath('projects', { fresh: true })).toBe('/api/projects?fresh=1')
  })
  it('任务板: /api/quests, fresh 加 ?fresh=1', () => {
    expect(listPath('quests', {})).toBe('/api/quests')
    expect(listPath('quests', { fresh: true })).toBe('/api/quests?fresh=1')
  })
  it('计划板: 无项目走全量 /api/plans, 选了项目走 /api/projects/{id}/plans(服务端归属)', () => {
    expect(listPath('plans', {})).toBe('/api/plans')
    expect(listPath('plans', { project: 'lofa' })).toBe('/api/projects/lofa/plans')
  })
  it('planDetailPath 分段编码; projectPlansPath', () => {
    expect(planDetailPath('_infra/[2026-05-01]X')).toBe('/api/plans/_infra/%5B2026-05-01%5DX')
    expect(projectPlansPath('lofa')).toBe('/api/projects/lofa/plans')
  })
})

describe('extractItems —— 各端点列表位置不同', () => {
  it('projects→projects[], quests→quests[], plans→items[]', () => {
    expect(extractItems('projects', { projects: [1] })).toEqual([1])
    expect(extractItems('quests', { quests: [2] })).toEqual([2])
    expect(extractItems('plans', { items: [3] })).toEqual([3])
    expect(extractItems('plans', null)).toEqual([])
  })
})

describe('projectFilterOptions —— 计划板的项目筛选(全部 + 各项目)', () => {
  it('从 /api/projects 响应派生, 第一项为全部', () => {
    const opts = projectFilterOptions({ projects: [{ id: 'lofa', name: 'LOFA' }, { id: 'x' }] })
    expect(opts[0]).toEqual({ id: '', name: '全部项目' })
    expect(opts[1]).toEqual({ id: 'lofa', name: 'LOFA' })
    expect(opts[2]).toEqual({ id: 'x', name: 'x' })   // 缺 name 用 id
  })
  it('空/缺数据只剩"全部"', () => {
    expect(projectFilterOptions(null)).toEqual([{ id: '', name: '全部项目' }])
  })
})

describe('后端原始项 → 统一卡片', () => {
  it('projectCard: 名称/分组/置顶/计划数/活跃时间/工作线; index_stale → status=stale', () => {
    const c = projectCard({
      id: 'lofa', name: 'LOFA', group: 'omnicompany', pinned: true, plan_count: 3,
      last_active: '2026-06-27T00:00:00+00:00', index_stale: true, stale_reason: '久未核对',
      threads: [{ name: '壳', status: 'active' }], activity_7d: [false, true],
    })
    expect(c).toMatchObject({
      board: 'projects', id: 'lofa', title: 'LOFA', group: 'omnicompany',
      pinned: true, planCount: 3, stale: true, status: 'stale',
    })
    expect(c.threads).toHaveLength(1)
  })
  it('projectCard: 无 name 用 id; 不 stale → status=active; last_active 退回 updated_at', () => {
    const c = projectCard({ id: 'x', updated_at: '2026-01-01T00:00:00+00:00' })
    expect(c.title).toBe('x')
    expect(c.status).toBe('active')
    expect(c.lastActive).toBe('2026-01-01T00:00:00+00:00')
  })
  it('questCard: 目标/章节/子目标/进行中计划数; status 默认 side', () => {
    const c = questCard({
      id: 'lofa', title: 'LOFA', status: 'main', objective: '远看 omnicompany',
      chapter: '接入项目板', sub_objectives: [{ id: 'p1', title: '计划一', date: '2026-06-27' }],
      active_plan_count: 2, last_active: '2026-06-27T00:00:00+00:00',
    })
    expect(c).toMatchObject({ board: 'quests', id: 'lofa', status: 'main', activePlanCount: 2 })
    expect(c.sub).toEqual([{ id: 'p1', title: '计划一', date: '2026-06-27' }])
    expect(questCard({ id: 'x' }).status).toBe('side')
  })
  it('planCard: title_zh 优先, 退回 [日期]主题; archived → status=archived', () => {
    expect(planCard({ id: 'a/[2026-06-01]X', topic: 'X', date: '2026-06-01', category: 'a', title_zh: '中文标题' }))
      .toMatchObject({ board: 'plans', title: '中文标题', status: 'active', archived: false })
    expect(planCard({ id: 'a/[2026-06-01]X', topic: 'X', date: '2026-06-01' }).title).toBe('2026-06-01 X')
    expect(planCard({ id: '_archive/Y', topic: 'Y', archived: true }))
      .toMatchObject({ status: 'archived', archived: true })
  })
  it('normalizeCards 按板分派', () => {
    expect(normalizeCards('quests', [{ id: 'q' }])[0].board).toBe('quests')
    expect(normalizeCards('plans', [{ id: 'p' }])[0].board).toBe('plans')
    expect(normalizeCards('projects', [{ id: 'pr' }])[0].board).toBe('projects')
    expect(normalizeCards('projects', null)).toEqual([])
  })
})

describe('客户端状态筛选', () => {
  const cards = [
    { id: 'a', status: 'active' }, { id: 'b', status: 'stale' }, { id: 'c', status: 'active' },
  ]
  it('空筛选返回全部', () => { expect(filterByStatus(cards, '')).toHaveLength(3) })
  it('按 status 过滤', () => {
    expect(filterByStatus(cards, 'stale').map((c) => c.id)).toEqual(['b'])
    expect(filterByStatus(cards, 'active').map((c) => c.id)).toEqual(['a', 'c'])
  })
  it('空入参不崩', () => { expect(filterByStatus(null, 'active')).toEqual([]) })
})
