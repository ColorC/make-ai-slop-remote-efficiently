// mobileTerminalInput.js — mobile IME guard for xterm's hidden textarea.
// Some Android keyboards restore/rewrite the whole editing context when they
// auto-pair smart quotes. xterm otherwise treats that context as fresh input.

const DEL = '\x7f'

function codePoints(value) { return Array.from(value || '') }

// Build the terminal edit needed to transform already-sent mobile text.
export function computeTerminalContextEdit(previous, next) {
  const before = codePoints(previous)
  const after = codePoints(next)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  return DEL.repeat(before.length - prefix) + after.slice(prefix).join('')
}

function longestCommonSubstringLength(left, right) {
  const a = codePoints(left).slice(-160)
  const b = codePoints(right).slice(-160)
  let best = 0
  let previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const current = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1
        best = Math.max(best, current[j])
      }
    }
    previous = current
  }
  return best
}

export function looksLikeRepeatedInputContext(previous, data) {
  const beforeLength = codePoints(previous).length
  const dataLength = codePoints(data).length
  if (beforeLength < 3 || dataLength < beforeLength) return false
  const common = longestCommonSubstringLength(previous, data)
  return common >= Math.max(3, Math.ceil(beforeLength * 0.6))
}

function defaultEnabled() {
  if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches } catch (e) { return false }
}

function removeLastCodePoint(value) {
  const points = codePoints(value)
  points.pop()
  return points.join('')
}

export function installMobileTerminalInputGuard(textarea, term, options) {
  options = options || {}
  textarea.autocomplete = 'off'
  textarea.autocapitalize = 'none'
  textarea.spellcheck = false
  textarea.setAttribute('autocorrect', 'off')
  textarea.setAttribute('data-gramm', 'false')
  textarea.setAttribute('data-gramm_editor', 'false')

  if (!(options.enabled == null ? defaultEnabled() : options.enabled)) return () => {}

  const inputEventRoot = options.eventRoot || textarea
  let composing = false
  let committed = ''
  let clearTimer = null

  const cancelClear = () => {
    if (clearTimer == null) return
    window.clearTimeout(clearTimer)
    clearTimer = null
  }
  const scheduleClear = () => {
    cancelClear()
    clearTimer = window.setTimeout(() => {
      clearTimer = null
      if (!composing) textarea.value = ''
    }, 0)
  }

  textarea.value = ''
  const onCompositionStart = () => { composing = true; cancelClear() }
  const onCompositionEnd = () => {
    composing = false
    const value = textarea.value
    if (value) committed = value
    scheduleClear()
  }
  const onInput = (event) => {
    if (composing || event.isComposing) return
    const data = event.data || ''
    const nextValue = textarea.value
    const restoredContext = Boolean(committed && data && nextValue !== data && nextValue.length >= data.length)
    const repeatedData = Boolean(committed && data && looksLikeRepeatedInputContext(committed, data))

    if (committed && data && (event.inputType === 'insertReplacementText' || restoredContext || repeatedData)) {
      const nextContext = restoredContext ? nextValue : data
      const edit = computeTerminalContextEdit(committed, nextContext)
      event.preventDefault()
      event.stopImmediatePropagation()
      textarea.value = ''
      committed = nextContext
      if (edit) term.input(edit, true)
      scheduleClear()
      return
    }

    if ((event.inputType || '').startsWith('delete')) committed = nextValue || removeLastCodePoint(committed)
    else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') committed = ''
    else if (data) committed = nextValue && nextValue !== data ? nextValue : committed + data
    scheduleClear()
  }
  const onKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === 'Escape' || event.ctrlKey || event.metaKey) committed = ''
  }
  const onBlur = () => {
    composing = false
    committed = ''
    cancelClear()
    textarea.value = ''
  }

  textarea.addEventListener('compositionstart', onCompositionStart, true)
  textarea.addEventListener('compositionend', onCompositionEnd)
  inputEventRoot.addEventListener('input', onInput, true)
  textarea.addEventListener('keydown', onKeyDown, true)
  textarea.addEventListener('blur', onBlur, true)

  return () => {
    cancelClear()
    textarea.removeEventListener('compositionstart', onCompositionStart, true)
    textarea.removeEventListener('compositionend', onCompositionEnd)
    inputEventRoot.removeEventListener('input', onInput, true)
    textarea.removeEventListener('keydown', onKeyDown, true)
    textarea.removeEventListener('blur', onBlur, true)
  }
}
