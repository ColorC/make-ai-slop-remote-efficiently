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

export function openNotes() {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return }
  const view = ensure()
  const url = store.base.replace(/\/+$/, '') + '/lofa/overlay/app/notes-web.html'
  const frame = view.querySelector('iframe')
  if (frame && frame.getAttribute('data-url') !== url) {
    frame.src = url
    frame.setAttribute('data-url', url)
  }
  router.push('notesView')
}
