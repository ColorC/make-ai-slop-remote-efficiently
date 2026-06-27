// Playwright 桌面 Web 流程测试 — 驱动真实的 app/www 页面, REST 与 WS 全部 mock。
// 覆盖 test_strategy: 发消息显示运行中→流式追加→停止发 interrupt→重连 snapshot 不重复→
//                    effort metadata PATCH→slash 原样发送。
import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5599'
const WS_GLOB = '**/api/cc/chat/sessions/*/ws'

// 每个用例独立的 mock 上下文
function freshCtx() {
  return {
    sent: [],                 // 页面→服务端发出的帧
    snapshotMessages: [],     // open/重连时回放的 snapshot
    ws: null,                 // 当前服务端侧 ws 句柄(用于强制断开测重连)
    metadataBody: null,       // 最近一次 metadata PATCH body
  }
}

async function setupRoutes(page, ctx) {
  // 进站前把 base 写进 localStorage, 让页面连到本地静态源(healthz 等被下面拦截)
  await page.addInitScript((base) => {
    try { localStorage.setItem('lofa.baseUrl', base) } catch (e) {}
  }, BASE)

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/healthz', (r) => json(r, { ok: true }))
  await page.route('**/api/android/register', (r) => json(r, { ok: true }))
  await page.route('**/api/android/log', (r) => json(r, { ok: true }))
  await page.route('**/api/android/apk/version', (r) => json(r, { manifest: null }))
  await page.route('**/api/boss-sight/reviewstage/_stats', (r) => json(r, { by_status: { pending: 0 }, pushed_unread: 0 }))
  await page.route('**/api/boss-sight/residents', (r) => json(r, { residents: [] }))
  await page.route('**/api/boss-sight/reviewstage?*', (r) => json(r, { items: [] }))

  await page.route('**/api/cc/chat/sessions', (r) => {
    if (r.request().method() === 'GET') {
      return json(r, { items: [{ id: 's1', kind: 'chat', provider: 'claude_code', name: '测试会话', alive: true, cwd: 'E:/x', effort: 'default' }] })
    }
    return json(r, { id: 's2', name: '新会话', provider: 'claude_code' })
  })

  // metadata PATCH (effort / model)
  await page.route('**/api/cc/chat/sessions/*/metadata', async (r) => {
    ctx.metadataBody = r.request().postDataJSON()
    const b = ctx.metadataBody || {}
    // 真后端 set_effort 返回 effort_applied 字符串(reconnected/after_current_turn/next_turn/unchanged),
    // 不是 boolean。会话在途时改档 → 'after_current_turn'(下一轮生效)。
    return json(r, {
      effort: b.effort !== undefined ? b.effort : 'high',
      effort_applied: 'after_current_turn',
      model: b.model !== undefined ? b.model : null,
      effective: 'next_user_turn',
    })
  })

  // WS mock: open 回放 snapshot;收 user.message 走 status→stream→complete;收 interrupt 回 aborted complete
  await page.routeWebSocket(WS_GLOB, (ws) => {
    ctx.ws = ws
    // 连上即回放 snapshot(重连去重核心)
    ws.send(JSON.stringify({ kind: 'snapshot', messages: ctx.snapshotMessages }))
    ws.onMessage((raw) => {
      let f; try { f = JSON.parse(raw) } catch (e) { return }
      ctx.sent.push(f)
      if (f.type === 'user.message') {
        ws.send(JSON.stringify({ kind: 'status', text: 'thinking…', canInterrupt: true }))
        if (/SLOW/.test(f.content || '')) return  // 模拟长任务, 等 interrupt
        ws.send(JSON.stringify({ kind: 'stream_delta', content: '答' }))
        ws.send(JSON.stringify({ kind: 'stream_delta', content: '案' }))
        ws.send(JSON.stringify({ kind: 'stream_delta', content: '完成' }))
        ws.send(JSON.stringify({ kind: 'text', role: 'assistant', content: '答案完成' }))
        ws.send(JSON.stringify({ kind: 'complete', sessionId: 's1' }))
      } else if (f.type === 'user.interrupt') {
        // 真 claude 中断路径: 后端 _broadcast_turn_error 发 error{code:'interrupted'} + result,
        // 不发 codex 式 complete{aborted}。e2e 必须走真后端形态, 别用 complete{aborted} 假绿。
        ws.send(JSON.stringify({ kind: 'error', code: 'interrupted', message: 'user interrupted' }))
        ws.send(JSON.stringify({ kind: 'result', is_error: true, session_id: 's1', duration_ms: 0, num_turns: 0, total_cost_usd: 0 }))
      }
    })
  })
}

async function gotoChat(page) {
  await page.goto('/')
  await expect(page.locator('#dot')).toHaveClass(/ok/, { timeout: 8000 }) // 连接成功
  await page.locator('#tabChat').click()
  await expect(page.locator('.sess', { hasText: '测试会话' })).toBeVisible()
  await page.locator('.sess', { hasText: '测试会话' }).click()
  await expect(page.locator('#convView')).toHaveClass(/show/)
}

test.describe('LOFA 对话流程(对齐电脑端)', () => {
  let ctx
  test.beforeEach(async ({ page }) => { ctx = freshCtx(); await setupRoutes(page, ctx) })

  test('发消息→运行中指示→流式追加→complete 收尾', async ({ page }) => {
    await gotoChat(page)
    await page.locator('#composerInput').fill('你好')
    await page.locator('#composerSend').click()
    // 用户气泡上屏
    await expect(page.locator('.msg.user', { hasText: '你好' })).toBeVisible()
    // 运行中指示出现过(complete 很快, 用 sent 帧 + 最终态双保险)
    await expect(page.locator('.msg.ai')).toHaveText('答案完成', { timeout: 7000 })
    await expect(page.locator('#runIndicator')).not.toHaveClass(/show/)
    expect(ctx.sent.some((f) => f.type === 'user.message' && f.content === '你好' && f.permissionMode === 'bypassPermissions')).toBe(true)
  })

  test('停止按钮发 user.interrupt 并显示已中断', async ({ page }) => {
    await gotoChat(page)
    await page.locator('#composerInput').fill('SLOW 跑个长任务')
    await page.locator('#composerSend').click()
    await expect(page.locator('#runIndicator')).toHaveClass(/show/)
    await page.locator('#btnStop').click()
    await expect(page.locator('.msg.sys', { hasText: '已中断' })).toBeVisible()
    await expect(page.locator('#runIndicator')).not.toHaveClass(/show/)
    expect(ctx.sent.some((f) => f.type === 'user.interrupt')).toBe(true)
  })

  test('重连后 snapshot 重放, 历史不重复', async ({ page }) => {
    ctx.snapshotMessages = [
      { kind: 'text', role: 'user', content: 'q1' },
      { kind: 'text', role: 'assistant', content: 'a1' },
    ]
    await gotoChat(page)
    await expect(page.locator('.msg')).toHaveCount(2)
    // 服务端强制断开 → 客户端自动重连 → 再次回放同一 snapshot
    await ctx.ws.close()
    await expect(page.locator('.msg')).toHaveCount(2, { timeout: 8000 }) // 不翻倍
    await expect(page.locator('.msg.user')).toHaveText('q1')
  })

  test('effort 选择器 PATCH metadata, after_current_turn 显示下一轮生效', async ({ page }) => {
    await gotoChat(page)
    await page.locator('#cvEffort').click()
    await page.locator('.modal-opt[data-v="high"]').click()
    await expect(page.locator('#cvEffort')).toHaveText('effort: high')
    // 后端返 effort_applied='after_current_turn' → 文案为"下一轮生效"(而非旧 boolean 恒假误判)
    await expect(page.locator('#toast')).toContainText('下一轮生效')
    expect(ctx.metadataBody).toEqual({ effort: 'high' })
  })

  test('slash 命令原样作为 user.message 发送', async ({ page }) => {
    await gotoChat(page)
    await page.locator('#slashBar button', { hasText: '/clear' }).click()
    await expect(page.locator('.msg.user', { hasText: '/clear' })).toBeVisible()
    const slash = ctx.sent.find((f) => f.type === 'user.message')
    expect(slash.content).toBe('/clear')   // 前端不特殊解析
  })

  test('工具卡按 toolId 配对(名/入参/结果)', async ({ page }) => {
    await gotoChat(page)
    // 手动驱动一组 tool_use/tool_result(直接经服务端侧 ws 推)
    await page.locator('#composerInput').fill('SLOW')
    await page.locator('#composerSend').click()
    await ctx.ws.send(JSON.stringify({ kind: 'tool_use', toolId: 'tA', toolName: 'Bash', input: { command: 'ls -la' } }))
    await expect(page.locator('.tool .tool-nm')).toContainText('Bash')
    await expect(page.locator('.tool .tool-st')).toHaveClass(/running/)
    await ctx.ws.send(JSON.stringify({ kind: 'tool_result', toolId: 'tA', resultText: 'a.txt' }))
    await expect(page.locator('.tool')).toHaveCount(1)        // 配对, 不新建
    await expect(page.locator('.tool .tool-st')).toHaveClass(/done/)
    await expect(page.locator('.tool')).toContainText('a.txt')
  })
})
