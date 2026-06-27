// 项目/任务/计划 接口契约测试 — 用 ajv 锁定 /api/projects、/api/quests、/api/plans、
// /api/projects/{id}/plans、/api/plans/{id} 的关键字段 schema。样本对齐已核实后端
// (controlplane/projects.py · plans.py · core/projects_registry.enrich_projects/build_quests
//  · core/plans_catalogue._scan)。
//
// 双向锁: schema 认的响应, 适配层(projectsState)必须能消费产出预期卡片。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Ajv from 'ajv'
import {
  extractItems, normalizeCards, projectCard, questCard, planCard, projectFilterOptions,
} from '../../../../app/www/js/projectsState.js'

const here = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(readFileSync(join(here, 'projects.schema.json'), 'utf8'))
const ajv = new Ajv({ allErrors: true })
ajv.addSchema(schema)
const v = (name) => {
  const fn = ajv.getSchema('lofa://projects#/$defs/' + name)
  if (!fn) throw new Error('no such schema def: ' + name)
  return fn
}

// ── 代表性真实响应样本(对齐后端字段) ──────────────────────────────────────
const PROJECTS_BOARD = {
  projects: [{
    id: 'lofa', name: 'LOFA', group: 'omnicompany', pinned: true, plan_count: 3,
    last_active: '2026-06-27T08:00:00+00:00', activity_7d: [false, true, true, false, false, true, true],
    index_ok: true, index_stale: false,
    threads: [{ name: '壳', status: 'active', status_ok: true, updated: '2026-06-27', note: null }],
    updated_at: '2026-06-27T08:00:00+00:00',
  }],
  groups_order: ['omnicompany', 'other'],
  group_labels: { omnicompany: 'Omnicompany', other: '其他' },
}
const QUESTS = {
  quests: [{
    id: 'lofa', title: 'LOFA', short: null, group: 'omnicompany',
    objective: '局域网远看 omnicompany', chapter: '接入项目工作板',
    sub_objectives: [{ id: 'lofa/[2026-06-20]SHELL', title: '移动壳', date: '2026-06-20' }],
    active_plan_count: 2, activity_7d: [true], last_active: '2026-06-27T08:00:00+00:00', status: 'main',
  }],
  groups_order: ['omnicompany'], group_labels: {}, updated_at: '2026-06-27T08:00:00+00:00',
}
const PLANS = {
  items: [
    { id: 'igame/[2026-06-01]X', topic: 'X', date: '2026-06-01', category: 'igame',
      folder_path: 'docs/plans/igame/[2026-06-01]X', file_count: 3, has_plan_md: true, title_zh: '中文标题' },
    { id: '_archive/[2026-05-01]OLD', topic: 'OLD', date: '2026-05-01', category: '_archive',
      folder_path: 'docs/plans/_archive/[2026-05-01]OLD', file_count: 0, has_plan_md: false, archived: true },
  ],
  total: 2,
}
const PROJECT_PLANS = {
  project: 'lofa',
  items: [{ id: 'lofa/[2026-06-20]SHELL', topic: 'SHELL', title_zh: '移动壳', date: '2026-06-20', category: 'lofa', archived: false }],
  plan_ids: ['lofa/[2026-06-20]SHELL'],
}
const PLAN_DETAIL = {
  id: 'igame/[2026-06-01]X', topic: 'X', date: '2026-06-01',
  folder_path: 'docs/plans/igame/[2026-06-01]X', archived: false,
  files: [{ path: 'plan.md', is_md: true, size: 999, mtime: 1.5, note_id_if_md: 'plans/igame/[2026-06-01]X/plan', summary: '计划摘要两行' }],
  meta: { status: 'active', work_type: 'planning', exit_criteria: [] },
}

describe('/api/projects 项目工作板 schema', () => {
  it('整板 {projects, groups_order, group_labels}', () => { expect(v('projectsBoard')(PROJECTS_BOARD)).toBe(true) })
  it('项目项必备 id+name+group', () => { expect(v('projectItem')(PROJECTS_BOARD.projects[0])).toBe(true) })
  it('缺 name 被拒', () => { expect(v('projectItem')({ id: 'x', group: 'g' })).toBe(false) })
  it('工作线 status 任意字符串(状态语义在前端徽标映射)', () => {
    expect(v('projectThread')({ name: '线', status: 'parked' })).toBe(true)
  })
})

describe('/api/quests 任务窗口 schema', () => {
  it('整体 {quests}', () => { expect(v('questsResponse')(QUESTS)).toBe(true) })
  it('任务项必备 id+title+status', () => { expect(v('questItem')(QUESTS.quests[0])).toBe(true) })
  it('缺 status 被拒', () => { expect(v('questItem')({ id: 'x', title: 't' })).toBe(false) })
})

describe('/api/plans 计划目录 schema', () => {
  it('整体 {items}', () => { expect(v('plansResponse')(PLANS)).toBe(true) })
  it('计划项必备 id+topic', () => { expect(v('planListItem')(PLANS.items[0])).toBe(true) })
  it('归档项带 archived=true', () => { expect(v('planListItem')(PLANS.items[1])).toBe(true) })
})

describe('/api/projects/{id}/plans 与 /api/plans/{id} schema', () => {
  it('项目关联计划 {project, items, plan_ids}', () => { expect(v('projectPlansResponse')(PROJECT_PLANS)).toBe(true) })
  it('缺 plan_ids 被拒', () => { expect(v('projectPlansResponse')({ project: 'x', items: [] })).toBe(false) })
  it('计划详情含 files', () => { expect(v('planDetail')(PLAN_DETAIL)).toBe(true) })
  it('详情缺 files 被拒', () => { expect(v('planDetail')({ id: 'a', topic: 't' })).toBe(false) })
})

describe('双向锁: schema 认的响应, 适配层能消费', () => {
  it('项目板 → projectCard(stale=false → status=active)', () => {
    expect(v('projectsBoard')(PROJECTS_BOARD)).toBe(true)
    const cards = normalizeCards('projects', extractItems('projects', PROJECTS_BOARD))
    expect(cards[0]).toMatchObject({ board: 'projects', id: 'lofa', title: 'LOFA', status: 'active', pinned: true, planCount: 3 })
    expect(cards[0].threads).toHaveLength(1)
    // 计划板的项目筛选选项也能从同一响应派生
    expect(projectFilterOptions(PROJECTS_BOARD).map((o) => o.id)).toEqual(['', 'lofa'])
  })
  it('任务 → questCard(status=main, 子目标透出)', () => {
    expect(v('questsResponse')(QUESTS)).toBe(true)
    const c = questCard(extractItems('quests', QUESTS)[0])
    expect(c).toMatchObject({ board: 'quests', id: 'lofa', status: 'main', activePlanCount: 2 })
    expect(c.sub[0].title).toBe('移动壳')
  })
  it('计划 → planCard(title_zh 优先 / 归档 → status=archived)', () => {
    expect(v('plansResponse')(PLANS)).toBe(true)
    const cards = normalizeCards('plans', extractItems('plans', PLANS))
    expect(cards[0]).toMatchObject({ board: 'plans', title: '中文标题', status: 'active' })
    expect(cards[1]).toMatchObject({ status: 'archived', archived: true })
  })
  it('项目关联计划项 → planCard', () => {
    expect(v('projectPlansResponse')(PROJECT_PLANS)).toBe(true)
    const c = planCard(PROJECT_PLANS.items[0])
    expect(c).toMatchObject({ board: 'plans', id: 'lofa/[2026-06-20]SHELL', title: '移动壳', status: 'active' })
  })
})
