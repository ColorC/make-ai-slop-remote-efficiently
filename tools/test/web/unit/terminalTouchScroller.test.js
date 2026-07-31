// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  installTerminalTouchScroller,
  isTerminalViewportAtBottom,
  TERMINAL_TOUCH_MAX_LINES_PER_MOVE,
} from '../../../../app/www/js/terminalTouchScroller.js'

function pointer(type, x, y) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  })
  Object.defineProperties(event, {
    pointerType: { value: 'touch' },
    pointerId: { value: 9 },
    isPrimary: { value: true },
  })
  return event
}

function fixture() {
  const root = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 400,
    width: 300, height: 400, toJSON: () => ({}),
  })
  root.appendChild(screen)
  document.body.appendChild(root)
  const scrollLines = vi.fn()
  const dispose = installTerminalTouchScroller(root, { rows: 20, scrollLines })
  return { root, screen, scrollLines, dispose }
}

describe('LOFA terminal touch scroller', () => {
  it('uses a deliberate one-finger vertical drag to reveal scrollback', () => {
    const { root, screen, scrollLines, dispose } = fixture()

    screen.dispatchEvent(pointer('pointerdown', 100, 100))
    screen.dispatchEvent(pointer('pointermove', 101, 145))

    expect(scrollLines).toHaveBeenCalledWith(-2)
    dispose()
    root.remove()
  })

  it('leaves taps, small movement and horizontal gestures untouched', () => {
    const { root, screen, scrollLines, dispose } = fixture()

    screen.dispatchEvent(pointer('pointerdown', 100, 100))
    screen.dispatchEvent(pointer('pointermove', 104, 112))
    screen.dispatchEvent(pointer('pointerup', 104, 112))
    screen.dispatchEvent(pointer('pointerdown', 100, 100))
    screen.dispatchEvent(pointer('pointermove', 140, 105))

    expect(scrollLines).not.toHaveBeenCalled()
    dispose()
    root.remove()
  })

  it('bounds a single move so an accidental jump cannot reach the top', () => {
    const { root, screen, scrollLines, dispose } = fixture()

    screen.dispatchEvent(pointer('pointerdown', 100, 390))
    screen.dispatchEvent(pointer('pointermove', 100, 10))

    expect(scrollLines).toHaveBeenCalledWith(TERMINAL_TOUCH_MAX_LINES_PER_MOVE)
    dispose()
    root.remove()
  })

  it('detects whether xterm is already showing the latest line', () => {
    expect(isTerminalViewportAtBottom({
      buffer: { active: { viewportY: 80, baseY: 80 } },
    })).toBe(true)
    expect(isTerminalViewportAtBottom({
      buffer: { active: { viewportY: 12, baseY: 80 } },
    })).toBe(false)
  })
})
