// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeTerminalContextEdit,
  installMobileTerminalInputGuard,
  looksLikeRepeatedInputContext,
} from '../../../../app/www/js/mobileTerminalInput.js'

function inputEvent(data, inputType = 'insertText', isComposing = false) {
  return new InputEvent('input', { bubbles: true, cancelable: true, data, inputType, isComposing })
}

function fixture() {
  const root = document.createElement('div')
  const textarea = document.createElement('textarea')
  root.appendChild(textarea)
  document.body.appendChild(root)
  const term = { input: vi.fn() }
  const dispose = installMobileTerminalInputGuard(textarea, term, { enabled: true, eventRoot: root })
  return { root, textarea, term, dispose }
}

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = '' })

describe('mobile terminal context edits', () => {
  it('rewrites smart quotes without resending the old context', () => {
    expect(computeTerminalContextEdit('abc"', '“abc”')).toBe('\x7f\x7f\x7f\x7f“abc”')
    expect(looksLikeRepeatedInputContext('abc"', '“abc”')).toBe(true)
    expect(looksLikeRepeatedInputContext('abc"', 'unrelated voice sentence')).toBe(false)
  })
})

describe('mobile terminal input guard', () => {
  it('intercepts restored full context and sends only the edit once', () => {
    vi.useFakeTimers()
    const { root, textarea, term, dispose } = fixture()
    const xtermInput = vi.fn()
    textarea.addEventListener('input', (event) => xtermInput(event.data))

    textarea.value = 'abc'
    textarea.dispatchEvent(inputEvent('abc'))
    vi.runAllTimers()
    textarea.value = 'abc"'
    textarea.dispatchEvent(inputEvent('"'))

    expect(term.input).toHaveBeenCalledWith('"', true)
    expect(xtermInput).toHaveBeenCalledTimes(1)
    expect(textarea.value).toBe('')
    dispose()
    root.remove()
  })

  it('turns a whole-context smart quote rewrite into one replacement', () => {
    vi.useFakeTimers()
    const { root, textarea, term, dispose } = fixture()
    textarea.value = 'abc"'
    textarea.dispatchEvent(inputEvent('abc"'))
    vi.runAllTimers()
    textarea.value = '“abc”'
    textarea.dispatchEvent(inputEvent('“abc”'))
    expect(term.input).toHaveBeenCalledWith('\x7f\x7f\x7f\x7f“abc”', true)
    dispose()
    root.remove()
  })

  it('leaves active Chinese composition to xterm and clears only after commit', () => {
    vi.useFakeTimers()
    const { root, textarea, term, dispose } = fixture()
    const xtermInput = vi.fn()
    textarea.addEventListener('input', xtermInput)
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    textarea.value = '你好'
    textarea.dispatchEvent(inputEvent('你好', 'insertCompositionText', true))
    vi.runAllTimers()
    expect(textarea.value).toBe('你好')
    expect(term.input).not.toHaveBeenCalled()
    expect(xtermInput).toHaveBeenCalledTimes(1)
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }))
    vi.runAllTimers()
    expect(textarea.value).toBe('')
    dispose()
    root.remove()
  })
})
