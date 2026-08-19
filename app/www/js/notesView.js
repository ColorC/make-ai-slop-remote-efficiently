// notesView.js - full-screen notes iframe.

import { store, toast } from './core.js'
import { icons } from './ui.js'
import * as router from './router.js'

function ensure() {
  const view = document.getElementById('notesView')
  if (view.querySelector('iframe')) return view
  view.innerHTML =
    '<button class="float-back" aria-label="\u8fd4\u56de">' + icons.back + '</button>' +
    '<iframe class="iframe-full" allow="clipboard-read; clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>'
  view.querySelector('.float-back').addEventListener('click', () => router.pop())
  return view
}

function notesUrl() {
  return store.base.replace(/\/+$/, '') + '/lofa/overlay/app/notes-web.html'
}

export function openNotes() {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return }
  const view = ensure()
  const url = notesUrl()
  const frame = view.querySelector('iframe')
  if (frame && frame.getAttribute('data-url') !== url) {
    frame.src = url
    frame.setAttribute('data-url', url)
  }
  router.push('notesView')
}

// A (re)connect re-mints this device's gateway session (remote.js \u2192
// DeviceAutomation.configure). A frame loaded before that session existed may be
// showing the gateway's 401 login page instead of the canvas \u2014 and because the frame
// is cross-origin we cannot read that, so `data-url` alone would keep the dead page
// forever (2026-08-19: the phone kept showing "\u9700\u8981\u767b\u5f55" long after the gateway route
// that rejected it was fixed). Refetch on connect; a fresh session deserves that anyway.
export function reloadAfterConnect() {
  const view = document.getElementById('notesView')
  const frame = view && view.querySelector('iframe')
  if (!frame) return
  frame.removeAttribute('data-url')
  if (!store.base || !frame.getAttribute('src')) return
  const url = notesUrl()
  frame.src = url
  frame.setAttribute('data-url', url)
}
