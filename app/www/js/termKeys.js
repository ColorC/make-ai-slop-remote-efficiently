// termKeys.js — 终端附加键条的纯逻辑(可单测,无 DOM 依赖)。
//   · KEY_ROWS   两行固定键位表(§7d),DOM 层照此渲染
//   · keySequence(key,{ctrl,alt}) → 终端写入序列(C0 控制码 / CSI 方向 / Home End PgUp PgDn / Esc Tab)
//   · createModifierState() 粘滞修饰键状态机(单点=下一键生效,长按=锁定,再点=取消)
// 约束:序列以真实终端约定为准;修饰状态与序列生成解耦,便于 DOM 薄封装与测试。

// 两行键位:每项 { id, label, mod?, hold? }。
//   id 是 keySequence 的入参键名(命名键或字面字符);mod 标记 Ctrl/Alt 粘滞键;
//   hold 是长按二级字符(/ → \,~ → 反引号)。顺序即渲染顺序,严格对齐 §7d。
export const KEY_ROWS = [
  [
    { id: 'Esc', label: 'Esc' },
    { id: '/', label: '/', hold: '\\' },
    { id: '|', label: '|' },
    { id: '~', label: '~', hold: '`' },
    { id: 'ArrowUp', label: '↑' },
    { id: 'Home', label: 'Home' },
    { id: 'PgUp', label: 'PgUp' },
  ],
  [
    { id: 'Tab', label: 'Tab' },
    { id: 'Ctrl', label: 'Ctrl', mod: 'ctrl' },
    { id: 'Alt', label: 'Alt', mod: 'alt' },
    { id: 'ArrowLeft', label: '←' },
    { id: 'ArrowDown', label: '↓' },
    { id: 'ArrowRight', label: '→' },
    { id: 'End', label: 'End' },
  ],
]

// 命名键:csi=true 者支持修饰键改写(CSI 1;<mod> 形式);Esc/Tab 是 C0,仅 Alt 前缀。
const NAMED = {
  Esc: { seq: '\x1b' },
  Tab: { seq: '\t' },
  ArrowUp: { csi: true, seq: '\x1b[A', mod: (m) => '\x1b[1;' + m + 'A' },
  ArrowDown: { csi: true, seq: '\x1b[B', mod: (m) => '\x1b[1;' + m + 'B' },
  ArrowRight: { csi: true, seq: '\x1b[C', mod: (m) => '\x1b[1;' + m + 'C' },
  ArrowLeft: { csi: true, seq: '\x1b[D', mod: (m) => '\x1b[1;' + m + 'D' },
  Home: { csi: true, seq: '\x1b[H', mod: (m) => '\x1b[1;' + m + 'H' },
  End: { csi: true, seq: '\x1b[F', mod: (m) => '\x1b[1;' + m + 'F' },
  PgUp: { csi: true, seq: '\x1b[5~', mod: (m) => '\x1b[5;' + m + '~' },
  PgDn: { csi: true, seq: '\x1b[6~', mod: (m) => '\x1b[6;' + m + '~' },
}

// Ctrl+字符 → C0 控制码。字母 A..Z → \x01..\x1a;@ [ \ ] ^ _ 空格 ? 按终端惯例映射。
// 不可映射者返回 null(表示 Ctrl 对该键无效,原字符照发)。
function ctrlCode(ch) {
  if (!ch) return null
  const c = ch[0]
  const up = c.toUpperCase()
  if (up >= 'A' && up <= 'Z') return String.fromCharCode(up.charCodeAt(0) - 64)
  const map = { '@': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, ' ': 0, '?': 127 }
  if (Object.prototype.hasOwnProperty.call(map, c)) return String.fromCharCode(map[c])
  return null
}

// 单个键 + 修饰键 → 写入终端的字节序列。
export function keySequence(key, mods) {
  mods = mods || {}
  const ctrl = !!mods.ctrl, alt = !!mods.alt
  const named = NAMED[key]
  if (named) {
    if (named.csi) {
      // CSI 修饰码:1 + Alt*2 + Ctrl*4(无 Shift 参与)。无修饰走基础序列。
      const m = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)
      return m > 1 ? named.mod(m) : named.seq
    }
    return alt ? ('\x1b' + named.seq) : named.seq   // Esc / Tab
  }
  // 字面字符键
  let ch = key
  if (ctrl) { const cc = ctrlCode(ch); if (cc != null) ch = cc }
  if (alt) ch = '\x1b' + ch
  return ch
}

// 粘滞修饰键状态机。每个修饰键三态:off / armed(单发,下一键生效后清)/ locked(锁定,持续)。
//   tap:off→armed,armed→off,locked→off(再点取消)
//   lock:任意→locked(长按)
//   consume:取当前修饰布尔,并把 armed 清回 off(locked 保留)
export function createModifierState() {
  const st = { ctrl: 'off', alt: 'off' }
  return {
    state: (m) => st[m],
    isActive: (m) => st[m] !== 'off',
    tap(m) { st[m] = (st[m] === 'off') ? 'armed' : 'off'; return st[m] },
    lock(m) { st[m] = 'locked'; return st[m] },
    consume() {
      const mods = { ctrl: st.ctrl !== 'off', alt: st.alt !== 'off' }
      if (st.ctrl === 'armed') st.ctrl = 'off'
      if (st.alt === 'armed') st.alt = 'off'
      return mods
    },
    reset() { st.ctrl = 'off'; st.alt = 'off' },
  }
}
