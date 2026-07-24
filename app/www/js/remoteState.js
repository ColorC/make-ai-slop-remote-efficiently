// Native device automation uses a control-plane endpoint that must stay
// network-distinct from the public HTTPS review gateway. This lets the server
// prove that a review probe result came back from an independent LAN device.
export function automationControlBase(base) {
  const raw = String(base || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' && url.port === '12443') {
      url.protocol = 'http:'
      url.port = '8210'
      url.pathname = ''
      url.search = ''
      url.hash = ''
      return url.origin
    }
    return url.origin
  } catch (e) {
    return raw
  }
}
