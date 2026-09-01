// term.spec — 终端屏(§7d):snapshot 重画出现文本、附加键条(Tab / Ctrl 粘滞组合 / 键盘 Ctrl+C)
//   往 WS 发正确 input 序列、exit 覆盖层出现。PTY WS 用 routeWebSocket mock。
// Archived local-terminal WIP; excluded from the single-frontend test suite.
import { test, expect } from '@playwright/test'
import { baseRoutes, installPtyWs, until, push } from './helpers.js'

async function openTerm(page) {
  const ctx = await baseRoutes(page)
  const ws = await installPtyWs(page)
  ctx.ptySessions = { items: [{ id: 'p1', cmd: ['powershell'], cwd: 'E:/proj', alive: true, last_output_at: Date.now() / 1000 }], recoverable: [] }
  await page.goto('/')
  await page.locator('#sessionsList .lg-row').first().waitFor()
  await page.locator('#sessionsList .lg-row').first().click()
  await expect(page.locator('#termView')).toHaveClass(/show/)
  await until(() => ws.ws)
  return { ctx, ws }
}

test.describe('终端屏', () => {
  test('touch-device DOM renderer opens without a runtime error and connects PTY', async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 })
    })

    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: ['mobile-terminal-ready\r\n'] })
    await until(() => page.evaluate(() => {
      const terminal = window.__lofaTerm
      if (!terminal) return false
      const buffer = terminal.buffer.active
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row)
        if (line && line.translateToString().includes('mobile-terminal-ready')) return true
      }
      return false
    }))

    expect(pageErrors).toEqual([])
  })

  test('snapshot 重画出现文本', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: ['snapshot-marker-42\r\n'] })
    // WebGL 渲染器把文本画进 canvas(DOM 无文字),断言走 xterm buffer 才是真端到端
    await until(() => page.evaluate(() => {
      const t = window.__lofaTerm; if (!t) return false
      const b = t.buffer.active
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString().includes('snapshot-marker-42')) return true }
      return false
    }))
    // 覆盖层在 snapshot 后收起。
    await expect(page.locator('#termView .term-overlay')).not.toHaveClass(/show/)
  })

  test('单指拖动可查看历史，并能一键回到最新内容', async ({ page }) => {
    const { ws } = await openTerm(page)
    const history = Array.from({ length: 180 }, (_, i) => `history-${i}\r\n`).join('')
    await push(ws, { type: 'snapshot', chunks: [history] })
    await until(() => page.evaluate(() => {
      const b = window.__lofaTerm && window.__lofaTerm.buffer.active
      return Boolean(b && b.baseY > 0 && b.viewportY === b.baseY)
    }))

    await page.evaluate(() => {
      const screen = document.querySelector('#termScreen .xterm-screen')
      const fire = (type, y) => screen.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: 7,
        isPrimary: true,
        clientX: 120,
        clientY: y,
      }))
      fire('pointerdown', 100)
      fire('pointermove', 180)
      fire('pointerup', 180)
    })

    await until(() => page.evaluate(() => {
      const b = window.__lofaTerm.buffer.active
      return b.viewportY < b.baseY
    }))
    await expect(page.locator('#termView .term-latest')).toBeVisible()
    await page.locator('#termView .term-latest').click()
    await until(() => page.evaluate(() => {
      const b = window.__lofaTerm.buffer.active
      return b.viewportY === b.baseY
    }))
    await expect(page.locator('#termView .term-latest')).not.toBeVisible()
  })

  test('streamed snapshot v2 preserves ANSI styles, Unicode, and requests redraw when truncated', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot_begin', meta: { replay_truncated: true, cols: 80, rows: 24 } })
    await push(ws, { type: 'snapshot_chunk', chunks: ['\x1b[31mRED\x1b[0m \x1b[44mBLUE_BG'] })
    await push(ws, { type: 'snapshot_chunk', chunks: ['\x1b[0m \x1b[1;33mBOLD_YELLOW\x1b[0m\r\n', '\u4e2d\u6587\uff1a\u7ec8\u7aef\u6062\u590d\u6d4b\u8bd5 \ud83d\ude00 \u250c\u2500\u2510\r\n'] })
    await push(ws, { type: 'snapshot_end' })

    await until(() => page.evaluate(() => {
      const t = window.__lofaTerm; if (!t) return false
      const b = t.buffer.active
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i)
        if (line && line.translateToString().includes('\u4e2d\u6587\uff1a\u7ec8\u7aef\u6062\u590d\u6d4b\u8bd5 \ud83d\ude00 \u250c\u2500\u2510')) return true
      }
      return false
    }))

    const attrs = await page.evaluate(() => {
      const t = window.__lofaTerm
      const b = t.buffer.active
      const found = {}
      for (let row = 0; row < b.length; row++) {
        const line = b.getLine(row); if (!line) continue
        const text = line.translateToString()
        for (const marker of ['RED', 'BLUE_BG', 'BOLD_YELLOW']) {
          const col = text.indexOf(marker)
          if (col < 0) continue
          const cell = line.getCell(col)
          found[marker] = {
            fgDefault: cell.isFgDefault(),
            bgDefault: cell.isBgDefault(),
            bold: Boolean(cell.isBold()),
          }
        }
      }
      return found
    })
    expect(attrs.RED.fgDefault).toBe(false)
    expect(attrs.BLUE_BG.bgDefault).toBe(false)
    expect(attrs.BOLD_YELLOW.fgDefault).toBe(false)
    expect(attrs.BOLD_YELLOW.bold).toBe(true)
    await until(() => ws.sent.find((m) => m.type === 'redraw' && m.cols > 0 && m.rows > 0))

    await push(ws, { type: 'output', data: 'live-output-after-replay\r\n' })
    await until(() => page.evaluate(() => {
      const b = window.__lofaTerm.buffer.active
      let text = ''
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) text += l.translateToString() + '\n' }
      return text.includes('BOLD_YELLOW') && text.includes('live-output-after-replay')
    }))
  })

  test('an incomplete streamed snapshot does not erase the last complete screen', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: ['stable-screen-before-reconnect\r\n'] })
    await until(() => page.evaluate(() => {
      const b = window.__lofaTerm.buffer.active
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString().includes('stable-screen-before-reconnect')) return true }
      return false
    }))

    await push(ws, { type: 'snapshot_begin', meta: {} })
    await push(ws, { type: 'snapshot_chunk', chunks: ['partial-snapshot-must-not-render\r\n'] })
    expect(await page.evaluate(() => {
      const b = window.__lofaTerm.buffer.active
      let text = ''
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) text += l.translateToString() + '\n' }
      return { stable: text.includes('stable-screen-before-reconnect'), partial: text.includes('partial-snapshot-must-not-render') }
    })).toEqual({ stable: true, partial: false })
  })

  test('reopening and resizing repeatedly restores a complete streamed snapshot', async ({ page }) => {
    test.setTimeout(60_000)
    const { ws } = await openTerm(page)
    for (let cycle = 0; cycle < 12; cycle++) {
      const marker = `reopen-cycle-${cycle}`
      await push(ws, { type: 'snapshot_begin', meta: { replay_truncated: cycle % 3 === 0 } })
      await push(ws, { type: 'snapshot_chunk', chunks: ['\x1b[36mhistory-still-visible\x1b[0m\r\n'] })
      await push(ws, { type: 'snapshot_chunk', chunks: [`${marker} \u4e2d\u6587 \ud83d\ude00 \u250c\u2500\u2510\r\n`] })
      await push(ws, { type: 'snapshot_end' })
      await push(ws, { type: 'output', data: `tail-${cycle}\r\n` })
      await until(() => page.evaluate(({ marker, tail }) => {
        const t = window.__lofaTerm; if (!t) return false
        const b = t.buffer.active
        let text = ''
        for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) text += l.translateToString() + '\n' }
        return text.includes('history-still-visible') && text.includes(marker) && text.includes(tail) && text.includes('\u4e2d\u6587 \ud83d\ude00 \u250c\u2500\u2510')
      }, { marker, tail: `tail-${cycle}` }))

      await page.setViewportSize({ width: 900 + (cycle % 2) * 37, height: 700 + (cycle % 3) * 29 })
      await until(() => ws.sent.find((m) => m.type === 'resize' && m.cols > 0 && m.rows > 0))
      if (cycle === 11) break

      const previous = ws.ws
      await page.locator('#termView .lg-nav-back').evaluate((button) => button.click())
      await page.locator('#sessionsList .lg-row').first().waitFor()
      await page.locator('#sessionsList .lg-row').first().click()
      await expect(page.locator('#termView')).toHaveClass(/show/)
      await until(() => ws.ws && ws.ws !== previous)
    }
  })

  test('附加键条:默认隐藏,顶栏 ⌨ 钉住后 Tab / Esc / 方向键 → 正确序列', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })

    // 键条默认收起(不常驻占屏),顶栏 ⌨ 钮召出(不再有压住输入行的右下角浮钮)
    await expect(page.locator('#termKeys')).not.toBeVisible()
    await expect(page.locator('#termView .term-kfab')).toHaveCount(0)
    await page.locator('#termView [data-t="kbtoggle"]').click()
    await expect(page.locator('#termKeys')).toBeVisible()

    await page.locator('#termKeys .term-key[data-key="Tab"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\t'))

    await page.locator('#termKeys .term-key[data-key="Esc"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b'))

    await page.locator('#termKeys .term-key[data-key="ArrowUp"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b[A'))
  })

  test('附加键条在终端上方:再点 ⌨ 收起,且键条与终端区不重叠', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    const toggle = page.locator('#termView [data-t="kbtoggle"]')
    await toggle.click()
    await expect(page.locator('#termKeys')).toBeVisible()

    const keys = await page.locator('#termKeys').boundingBox()
    const body = await page.locator('#termView .term-body').boundingBox()
    // 键条整体在终端区之上:底边 ≤ 终端区顶边(不可能压住最后一行 = CLI 输入行)
    expect(keys.y + keys.height).toBeLessThanOrEqual(body.y + 1)

    await toggle.click()                                   // 显式开关:再点即收
    await expect(page.locator('#termKeys')).not.toBeVisible()
  })

  test('附加键条:Ctrl 粘滞 + 方向键 → CSI 修饰序列', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await page.locator('#termView [data-t="kbtoggle"]').click()   // 先召出键条
    // 点亮 Ctrl(点=armed),下一个方向键组合发送。
    await page.locator('#termKeys .term-key[data-mod="ctrl"]').click()
    await expect(page.locator('#termKeys .term-key[data-mod="ctrl"]')).toHaveClass(/armed/)
    await page.locator('#termKeys .term-key[data-key="ArrowUp"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b[1;5A'))
  })

  test('附加键条:「换行」→ ESC CR,^C → \\x03', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await page.locator('#termView [data-t="kbtoggle"]').click()

    // 移动端软键盘的回车只能提交;多行输入唯一可达的手段就是这颗键。
    await page.locator('#termKeys .term-key[data-key="Newline"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b\r'))

    await page.locator('#termKeys .term-key[data-key="CtrlC"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x03'))
  })

  test('附加键条:Alt 锁定时「换行」仍是纯 ESC CR(成品键不叠加修饰)', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await page.locator('#termView [data-t="kbtoggle"]').click()
    await page.locator('#termKeys .term-key[data-mod="alt"]').click()
    await expect(page.locator('#termKeys .term-key[data-mod="alt"]')).toHaveClass(/armed/)
    await page.locator('#termKeys .term-key[data-key="Newline"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b\r'))
    expect(ws.sent.find((m) => m.type === 'input' && m.data === '\x1b\x1b\r')).toBeUndefined()
  })

  test('长按二级浮泡吊在键条之下:不盖住任何一颗键,泡外点击不穿透到终端', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await page.locator('#termView [data-t="kbtoggle"]').click()

    // 长按第二行的「换行」出 \n 泡。泡若按"键的上方"定位会正好盖住第一行的 `|` 键(实测踩过)。
    const nl = page.locator('#termKeys .term-key[data-key="Newline"]')
    const box = await nl.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    const bub = page.locator('.term-hold')
    await expect(bub).toBeVisible()

    const bar = await page.locator('#termKeys').boundingBox()
    const bb = await bub.boundingBox()
    expect(bb.y).toBeGreaterThanOrEqual(bar.y + bar.height)      // 整条之下
    for (const k of await page.locator('#termKeys .term-key').all()) {
      const kb = await k.boundingBox()
      expect(bb.y, '浮泡不得与键位重叠: ' + (await k.getAttribute('data-key')))
        .toBeGreaterThanOrEqual(kb.y + kb.height)
    }

    // 泡外那一下只收泡:既不发序列,也不该把焦点(=输入法)交给终端
    await page.mouse.up()
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height + 120)
    await expect(bub).toHaveCount(0)
    expect(ws.sent.find((m) => m.type === 'input' && m.data === '\n')).toBeUndefined()
    expect(await page.evaluate(() => Boolean(document.activeElement
      && document.activeElement.classList.contains('xterm-helper-textarea')))).toBe(false)
  })

  test('按键条不夺焦、不穿透:终端 textarea 不会被意外聚焦', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 })
    })
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })

    const focused = () => page.evaluate(() =>
      Boolean(document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea')))

    // 召出键条本身不该把焦点(=移动端输入法)带出来
    await page.locator('#termView [data-t="kbtoggle"]').click()
    expect(await focused()).toBe(false)

    // 按普通键 / 修饰键 / 条上空隙都不该聚焦终端
    await page.locator('#termKeys .term-key[data-key="Esc"]').click()
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x1b'))
    expect(await focused()).toBe(false)

    await page.locator('#termKeys .term-key[data-mod="ctrl"]').click()
    expect(await focused()).toBe(false)

    const bar = await page.locator('#termKeys').boundingBox()
    await page.mouse.click(bar.x + 2, bar.y + 2)   // 条的内边距(键与键之外)
    expect(await focused()).toBe(false)
  })

  test('终端键盘 Ctrl+C → \\x03 上行', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await page.locator('#termScreen .xterm-helper-textarea').focus()
    await page.keyboard.press('Control+C')
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x03'))
  })

  test('移动输入法智能引号只发送差量，不重复此前文字', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 })
    })
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })

    await page.locator('#termScreen .xterm-helper-textarea').evaluate((textarea) => {
      const fire = (data) => textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data,
        inputType: 'insertText',
      }))
      textarea.value = 'abc"'
      fire('abc"')
    })
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === 'abc"'))

    await page.locator('#termScreen .xterm-helper-textarea').evaluate((textarea) => {
      textarea.value = '“abc”'
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: '“abc”',
        inputType: 'insertText',
      }))
    })
    await until(() => ws.sent.find((m) => m.type === 'input' && m.data === '\x7f\x7f\x7f\x7f“abc”'))
    expect(ws.sent.filter((m) => m.type === 'input' && m.data === '“abc”')).toHaveLength(0)
  })

  test('exit → 覆盖层出现并可回列表', async ({ page }) => {
    const { ws } = await openTerm(page)
    await push(ws, { type: 'snapshot', chunks: [''] })
    await push(ws, { type: 'exit', reason: 'process exited' })
    await expect(page.locator('#termView .term-overlay')).toHaveClass(/show/)
    await expect(page.locator('#termView .term-overlay')).toContainText('会话已结束')
    await expect(page.locator('#termView .term-overlay .lg-btn')).toContainText('回列表')
  })
})
