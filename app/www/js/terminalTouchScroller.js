export const TERMINAL_TOUCH_DRAG_THRESHOLD_PX = 16
export const TERMINAL_TOUCH_MAX_LINES_PER_MOVE = 12

export function isTerminalViewportAtBottom(term) {
  const buffer = term && term.buffer && term.buffer.active
  if (!buffer) return true
  return Number(buffer.viewportY || 0) >= Number(buffer.baseY || 0)
}

function terminalLineHeight(root, term) {
  const screen = root.querySelector('.xterm-screen')
  const rows = Number(term && term.rows) || 0
  const measured = screen && screen.getBoundingClientRect
    ? screen.getBoundingClientRect().height
    : 0
  if (rows > 0 && measured > 0) return measured / rows

  const fontSize = Number.parseFloat(getComputedStyle(root).fontSize || '')
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 18
}

function isPrimaryTouch(event) {
  return event.pointerType === 'touch' && event.isPrimary !== false
}

/**
 * Android WebView does not consistently turn a direct drag over xterm's
 * renderer into scrollback movement. Convert a deliberate one-finger vertical
 * drag into bounded xterm line scrolling and leave taps/horizontal gestures
 * untouched.
 */
export function installTerminalTouchScroller(root, term) {
  let drag = null
  let suppressClickUntil = 0

  const onPointerDown = (event) => {
    if (event.pointerType !== 'touch') return
    if (!isPrimaryTouch(event)) {
      drag = null
      return
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
      remainderPx: 0,
      dragging: false,
    }
  }

  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return

    const totalX = event.clientX - drag.startX
    const totalY = event.clientY - drag.startY
    if (!drag.dragging) {
      if (Math.abs(totalY) < TERMINAL_TOUCH_DRAG_THRESHOLD_PX) return
      if (Math.abs(totalX) >= Math.abs(totalY)) {
        drag = null
        return
      }
      drag.dragging = true
      try { if (root.setPointerCapture) root.setPointerCapture(event.pointerId) } catch (e) {}
    }

    event.preventDefault()
    event.stopPropagation()
    drag.remainderPx += drag.lastY - event.clientY
    drag.lastY = event.clientY

    const lineHeight = terminalLineHeight(root, term)
    const rawLines = Math.trunc(drag.remainderPx / lineHeight)
    if (rawLines === 0) return
    drag.remainderPx -= rawLines * lineHeight
    const lines = Math.max(
      -TERMINAL_TOUCH_MAX_LINES_PER_MOVE,
      Math.min(TERMINAL_TOUCH_MAX_LINES_PER_MOVE, rawLines),
    )
    term.scrollLines(lines)
  }

  const finish = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const completed = drag
    drag = null
    try { if (root.releasePointerCapture) root.releasePointerCapture(event.pointerId) } catch (e) {}
    if (!completed.dragging) return

    event.preventDefault()
    event.stopPropagation()
    suppressClickUntil = Date.now() + 450
  }

  const onClick = (event) => {
    if (Date.now() > suppressClickUntil) return
    event.preventDefault()
    event.stopPropagation()
    suppressClickUntil = 0
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', finish, true)
  root.addEventListener('pointercancel', finish, true)
  root.addEventListener('click', onClick, true)

  return () => {
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('pointermove', onPointerMove, true)
    root.removeEventListener('pointerup', finish, true)
    root.removeEventListener('pointercancel', finish, true)
    root.removeEventListener('click', onClick, true)
  }
}
