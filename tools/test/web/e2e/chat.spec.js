// chat.spec — 对话屏(§7c):发消息回显、流式追加、工具卡折叠/展开/聚拢、中断、
//   温和已中断、pill 会话设置改 effort(codex 档位 / omni 置灰)、slash 浮层键盘导航。
import { test, expect } from '@playwright/test'
import { baseRoutes, installChatWs, until, push, json } from './helpers.js'

// 开一个指定 provider 的对话:mock 单会话 → 落列表 → 点行进对话屏 → 等 WS 就绪。
async function openChat(page, provider = 'claude_code') {
  const ctx = await baseRoutes(page)
  const ws = await installChatWs(page)
  ctx.chatSessions = { items: [{ id: 'c1', kind: 'chat', name: '测试对话', provider, cwd: 'E:/proj', alive: true, started_at: Date.now() / 1000 }] }
  await page.goto('/')
  await page.locator('#sessionsList .lg-row').first().waitFor()
  await page.locator('#sessionsList .lg-row').first().click()
  await expect(page.locator('#chatView')).toHaveClass(/show/)
  await until(() => ws.ws)
  return { ctx, ws }
}

test.describe('对话屏', () => {
  test('发消息回显 + user.message 上行', async ({ page }) => {
    const { ws } = await openChat(page)
    await page.fill('#chatInput', '你好世界')
    await expect(page.locator('#chatSend')).toHaveClass(/ready/)
    await page.locator('#chatSend').click()
    await expect(page.locator('#chatMsgs .msg-row.user .user-bubble')).toHaveText('你好世界')
    await until(() => ws.sent.find((m) => m.type === 'user.message' && m.content === '你好世界'))
  })

  test('流式追加 + stream_end 定稿', async ({ page }) => {
    const { ws } = await openChat(page)
    await push(ws, { kind: 'stream_delta', content: 'Hello' })
    await push(ws, { kind: 'stream_delta', content: ' world' })
    await expect(page.locator('#chatMsgs .ai-bubble')).toHaveText('Hello world')
    await expect(page.locator('#chatMsgs .ai-bubble')).toHaveClass(/streaming/)
    await push(ws, { kind: 'stream_end' })
    await expect(page.locator('#chatMsgs .ai-bubble')).not.toHaveClass(/streaming/)
  })

  test('工具卡:运行中单行 → 完成折叠 → 点开展开结果', async ({ page }) => {
    const { ws } = await openChat(page)
    await push(ws, { kind: 'tool_use', toolId: 't1', toolName: 'Bash', toolInput: { command: 'ls -la' } })
    const card = page.locator('#chatMsgs .tool-card')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveClass(/running/)
    await expect(card.locator('.tool-name')).toHaveText('Bash')
    await expect(card.locator('.tool-arg')).toHaveText('ls -la')

    await push(ws, { kind: 'tool_result', toolId: 't1', content: 'total 0\nfile.txt', isError: false })
    await expect(card).toHaveClass(/ok/)
    await expect(card).not.toHaveClass(/open/)   // 完成保持单行折叠
    await card.locator('.tool-head').click()
    await expect(card).toHaveClass(/open/)
    await expect(card.locator('.tool-pre').last()).toContainText('file.txt')
  })

  test('工具卡聚拢:连续 3 张已完成 → N 个步骤', async ({ page }) => {
    const { ws } = await openChat(page)
    for (const id of ['t1', 't2', 't3']) {
      await push(ws, { kind: 'tool_use', toolId: id, toolName: 'Read', toolInput: { file_path: id + '.js' } })
      await push(ws, { kind: 'tool_result', toolId: id, content: 'ok', isError: false })
    }
    const grp = page.locator('#chatMsgs .tool-group')
    await expect(grp).toHaveCount(1)
    await expect(grp.locator('.tool-group-head')).toHaveText('3 个步骤')
    await grp.locator('.tool-group-head').click()
    await expect(grp).toHaveClass(/open/)
    await expect(grp.locator('.tool-card')).toHaveCount(3)
  })

  test('中断:发消息后停止钮 → user.interrupt + 温和已中断', async ({ page }) => {
    const { ws } = await openChat(page)
    await page.fill('#chatInput', '跑个长任务')
    await page.locator('#chatSend').click()
    await expect(page.locator('#chatSend')).toHaveClass(/stop/)   // 运行中三态转停止
    await page.locator('#chatSend').click()
    await until(() => ws.sent.find((m) => m.type === 'user.interrupt'))

    await push(ws, { kind: 'error', code: 'interrupted', message: 'user interrupted' })
    const sys = page.locator('#chatMsgs .msg-sys')
    await expect(sys).toContainText('已中断')
    await expect(sys).not.toHaveClass(/err/)   // 温和灰,不刷红
  })

  test('pill 设置 sheet:claude effort 档位改 high 即时生效', async ({ page }) => {
    const { ctx } = await openChat(page, 'claude_code')
    const patched = []
    await page.route(/\/api\/cc\/chat\/sessions\/c1\/metadata/, (r) => {
      patched.push(r.request().postDataJSON())
      return json(r, { effort: 'high', effort_applied: 'unchanged' })
    })
    await page.locator('#chatHeadPill').click()
    await expect(page.locator('.lg-sheet-title')).toHaveText('会话设置')
    // claude effort 档位含 low..max。
    await expect(page.locator('.lg-sheet-radio .lg-sheet-l', { hasText: /^max$/ })).toHaveCount(1)
    await page.locator('.lg-sheet').getByText('high', { exact: true }).click()
    await until(() => patched.find((p) => p && p.effort === 'high'))
    await expect(page.locator('#chatHeadPill')).toContainText('high')
    void ctx
  })

  test('pill 设置 sheet:codex 档位差异(minimal)', async ({ page }) => {
    await openChat(page, 'codex')
    await page.locator('#chatHeadPill').click()
    await expect(page.locator('.lg-sheet-radio .lg-sheet-l', { hasText: /^minimal$/ })).toHaveCount(1)
  })

  test('pill 设置 sheet:omni_agent effort 置灰不支持', async ({ page }) => {
    await openChat(page, 'omni_agent')
    await page.locator('#chatHeadPill').click()
    const disabled = page.locator('.lg-sheet .lg-sheet-row.disabled')
    await expect(disabled).toContainText('不支持')
  })

  test('slash 浮层:过滤 + 键盘上下选 + 回车填入', async ({ page }) => {
    await openChat(page)
    await page.fill('#chatInput', '/')
    await expect(page.locator('#chatSlash')).toHaveClass(/show/)
    await page.fill('#chatInput', '/co')
    const items = page.locator('#chatSlash .chat-slash-item')
    await expect(items).toHaveCount(3)   // /compact /context /cost
    await expect(items.nth(0)).toHaveClass(/on/)
    await page.locator('#chatInput').press('ArrowDown')
    await expect(items.nth(1)).toHaveClass(/on/)
    await page.locator('#chatInput').press('Enter')
    await expect(page.locator('#chatSlash')).not.toHaveClass(/show/)
    await expect(page.locator('#chatInput')).toHaveValue('/context ')
  })
})
