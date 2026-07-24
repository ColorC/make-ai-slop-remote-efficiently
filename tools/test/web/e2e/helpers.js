// e2e 共享装置 — REST 全部 page.route mock,WS 用 routeWebSocket mock。
//   baseRoutes 铺无关紧要的健康/计数/配置端点与三条会话列表 GET(可经 ctx 改写);
//   installChatWs / installPtyWs 归一化 WS 往返;until 用事件/状态轮询取代 waitForTimeout。
// 静态服务 serve.mjs 由 playwright.config 的 webServer 托管;此处只拦截 /api/* 与 WS。

import { expect } from '@playwright/test'

// getSaved() 作废 http:// 存值,故 base 必须 https;healthz 被 mock,连接即成功。
export const BASE = 'https://localhost:5599'

export const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

// 事件/状态驱动的等待(禁 waitForTimeout 凑合)。fn 返回真值即通过。
export async function until(fn, { timeout = 6000, interval = 25 } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error('until: 超时')
    await new Promise((r) => setTimeout(r, interval))
  }
}

function defaultChatMeta(body) {
  return {
    id: 'new-chat', kind: 'chat', name: body.name || '新对话',
    provider: body.provider || 'claude_code', cwd: body.cwd || '',
    effort: null, model: null, active_plan: null, alive: true, running: false,
  }
}
function defaultPtyMeta(body) {
  return {
    id: 'new-term', cmd: body.cmd || null, cwd: body.cwd || '',
    cols: body.cols, rows: body.rows, alive: true, last_output_at: Date.now() / 1000,
  }
}

// 铺基础 REST。返回 ctx:改 ctx.chatSessions / ctx.ptySessions / ctx.active 即改列表返回;
// 建会话的 POST body 落进 ctx.chatCreates / ctx.ptyCreates。
export async function baseRoutes(page, opts = {}) {
  await page.addInitScript((base) => { try { localStorage.setItem('lofa.baseUrl', base) } catch (e) {} }, BASE)
  const ctx = {
    chatSessions: opts.chatSessions || { items: [] },
    ptySessions: opts.ptySessions || { items: [], recoverable: [] },
    active: opts.active || {},
    chatCreates: [],
    ptyCreates: [],
    chatCreated: opts.chatCreated || defaultChatMeta,
    ptyCreated: opts.ptyCreated || defaultPtyMeta,
  }

  await page.route(/\/api\/healthz/, (r) => json(r, { ok: true }))
  await page.route(/\/api\/android\/register/, (r) => json(r, { ok: true }))
  await page.route(/\/api\/android\/log/, (r) => json(r, { ok: true }))
  await page.route(/\/api\/android\/apk\/version/, (r) => json(r, { manifest: null }))
  await page.route(/\/api\/android\/commands\/poll/, (r) => json(r, { commands: [] }))
  await page.route(/\/api\/android\/commands\/result/, (r) => json(r, { ok: true }))
  await page.route(/\/lofa-config\.json/, (r) => json(r, { code: null }))
  await page.route(/\/api\/boss-sight\/reviewstage\/_stats/, (r) => json(r, { by_status: { pending: 0 }, pushed_unread: 0 }))
  await page.route(/\/api\/boss-sight\/residents/, (r) => json(r, { residents: [] }))

  await page.route(/\/api\/cc\/chat\/sessions(\?|$)/, (r) => {
    const req = r.request()
    if (req.method() === 'GET') return json(r, ctx.chatSessions)
    const body = req.postDataJSON() || {}
    ctx.chatCreates.push(body)
    return json(r, ctx.chatCreated(body))
  })
  await page.route(/\/api\/cc\/chat\/active/, (r) => json(r, ctx.active))
  await page.route(/\/api\/cc\/sessions(\?|$)/, (r) => {
    const req = r.request()
    if (req.method() === 'GET') return json(r, ctx.ptySessions)
    const body = req.postDataJSON() || {}
    ctx.ptyCreates.push(body)
    return json(r, ctx.ptyCreated(body))
  })

  return ctx
}

// chat 归一化帧 WS mock。state.ws=路由;state.sent=客户端发来的帧(已 JSON.parse)。
export async function installChatWs(page) {
  const state = { ws: null, sent: [] }
  await page.routeWebSocket(/\/api\/cc\/chat\/sessions\/[^/]+\/ws$/, (ws) => {
    state.ws = ws
    ws.onMessage((m) => { try { state.sent.push(JSON.parse(m)) } catch (e) { state.sent.push(m) } })
  })
  return state
}

// PTY WS mock {type:snapshot/output/exit} 往返。
export async function installPtyWs(page) {
  const state = { ws: null, sent: [] }
  await page.routeWebSocket(/\/api\/cc\/sessions\/[^/]+\/ws$/, (ws) => {
    state.ws = ws
    ws.onMessage((m) => { try { state.sent.push(JSON.parse(m)) } catch (e) { state.sent.push(m) } })
  })
  return state
}

// 从 mock WS 往客户端推一帧。
export async function push(state, frame) {
  await state.ws.send(JSON.stringify(frame))
}

// goto 首页并等到会话列表加载出内容(行或空态)。
export async function landSessions(page) {
  await page.goto('/')
  await expect(page.locator('#sessionsView')).toHaveClass(/show/)
  await page.locator('#sessionsList').locator('.lg-row, .lg-empty').first().waitFor()
}
