// LOFA shell navigation. Business navigation is delegated to Dashboard.
import { closeTopLayer } from './ui.js'

const state = { tabs: {}, defaultTab: null, tab: null, stack: [] }
const openers = {}
const listeners = []
const el = (id) => document.getElementById(id)
const views = () => Array.from(document.querySelectorAll('#viewport > .view'))

export function current() { return state.stack[state.stack.length - 1] }

function notify() {
  const value = { tab: state.tab, view: current() }
  listeners.forEach((listener) => { try { listener(value) } catch (error) {} })
}

function showOnly(viewId) {
  views().forEach((view) => view.classList.toggle('show', view.id === viewId))
}

export function init(options = {}) {
  state.tabs = options.tabs || {}
  state.defaultTab = options.defaultTab || Object.keys(state.tabs)[0]
  tab(state.defaultTab)
}

export function tab(name) {
  const root = state.tabs[name]
  if (!root) return false
  state.tab = name
  state.stack = [root]
  showOnly(root)
  notify()
  return true
}

export function push(viewId) {
  if (!el(viewId)) return false
  if (current() !== viewId) state.stack.push(viewId)
  showOnly(viewId)
  notify()
  return true
}

export function pop() {
  if (state.stack.length <= 1) return false
  state.stack.pop()
  showOnly(current())
  notify()
  return true
}

export function back() {
  if (closeTopLayer()) return true
  return pop()
}

export function open(kind, payload) {
  if (openers[kind]) return openers[kind](payload)
  const match = String(kind || '').match(/^([\w-]+):(.+)$/)
  return match && openers[match[1]] ? openers[match[1]](match[2]) : false
}

export function registerOpener(kind, fn) { openers[kind] = fn }
export function onChange(listener) { if (typeof listener === 'function') listeners.push(listener) }
export function setBadge() {}
