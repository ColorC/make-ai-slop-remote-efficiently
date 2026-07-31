// Native automation uses the same HTTPS origin as the WebView. Device identity
// comes from the paired per-device token, not from a plaintext port or source IP.
export function automationControlBase(base) {
  const raw = String(base || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.origin
  } catch (e) {
    return raw
  }
}
