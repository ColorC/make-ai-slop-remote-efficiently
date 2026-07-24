// termKeys 单测 — 附加键条纯逻辑:普通键 / 组合键 / CSI 方向 / 粘滞修饰状态机。
import { describe, it, expect } from 'vitest'
import { KEY_ROWS, keySequence, createModifierState } from '../../../../app/www/js/termKeys.js'

describe('KEY_ROWS 键位表对齐 §7d', () => {
  it('第一行 = Esc / | ~ ↑ Home PgUp', () => {
    expect(KEY_ROWS[0].map((k) => k.id)).toEqual(['Esc', '/', '|', '~', 'ArrowUp', 'Home', 'PgUp'])
  })
  it('第二行 = Tab Ctrl Alt ← ↓ → End', () => {
    expect(KEY_ROWS[1].map((k) => k.id)).toEqual(['Tab', 'Ctrl', 'Alt', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'End'])
  })
  it('Ctrl / Alt 标为修饰键;/ 与 ~ 带长按二级', () => {
    const flat = KEY_ROWS.flat()
    expect(flat.find((k) => k.id === 'Ctrl').mod).toBe('ctrl')
    expect(flat.find((k) => k.id === 'Alt').mod).toBe('alt')
    expect(flat.find((k) => k.id === '/').hold).toBe('\\')
    expect(flat.find((k) => k.id === '~').hold).toBe('`')
  })
})

describe('keySequence 普通键', () => {
  it('字面字符原样返回', () => {
    expect(keySequence('/')).toBe('/')
    expect(keySequence('a')).toBe('a')
    expect(keySequence('~')).toBe('~')
    expect(keySequence('`')).toBe('`')
    expect(keySequence('\\')).toBe('\\')
  })
  it('Esc / Tab 命名键', () => {
    expect(keySequence('Esc')).toBe('\x1b')
    expect(keySequence('Tab')).toBe('\t')
  })
  it('CSI 方向 / Home / End / PgUp / PgDn', () => {
    expect(keySequence('ArrowUp')).toBe('\x1b[A')
    expect(keySequence('ArrowDown')).toBe('\x1b[B')
    expect(keySequence('ArrowRight')).toBe('\x1b[C')
    expect(keySequence('ArrowLeft')).toBe('\x1b[D')
    expect(keySequence('Home')).toBe('\x1b[H')
    expect(keySequence('End')).toBe('\x1b[F')
    expect(keySequence('PgUp')).toBe('\x1b[5~')
    expect(keySequence('PgDn')).toBe('\x1b[6~')
  })
})

describe('keySequence 组合键', () => {
  it('Ctrl+字母 → C0 控制码', () => {
    expect(keySequence('a', { ctrl: true })).toBe('\x01')
    expect(keySequence('c', { ctrl: true })).toBe('\x03')
    expect(keySequence('C', { ctrl: true })).toBe('\x03')
    expect(keySequence('z', { ctrl: true })).toBe('\x1a')
  })
  it('Ctrl+符号 → 特定控制码', () => {
    expect(keySequence('[', { ctrl: true })).toBe('\x1b')
    expect(keySequence('\\', { ctrl: true })).toBe('\x1c')
    expect(keySequence(' ', { ctrl: true })).toBe('\x00')
    expect(keySequence('?', { ctrl: true })).toBe('\x7f')
  })
  it('Ctrl 对不可映射字符无效,原样发', () => {
    expect(keySequence('1', { ctrl: true })).toBe('1')
  })
  it('Alt+字符 → ESC 前缀', () => {
    expect(keySequence('a', { alt: true })).toBe('\x1ba')
    expect(keySequence('.', { alt: true })).toBe('\x1b.')
  })
  it('Ctrl+Alt+字母 → ESC + C0', () => {
    expect(keySequence('a', { ctrl: true, alt: true })).toBe('\x1b\x01')
  })
  it('修饰键改写方向键 → CSI 1;<mod>', () => {
    expect(keySequence('ArrowUp', { ctrl: true })).toBe('\x1b[1;5A')
    expect(keySequence('ArrowLeft', { alt: true })).toBe('\x1b[1;3D')
    expect(keySequence('ArrowRight', { ctrl: true, alt: true })).toBe('\x1b[1;7C')
    expect(keySequence('Home', { ctrl: true })).toBe('\x1b[1;5H')
    expect(keySequence('PgUp', { ctrl: true })).toBe('\x1b[5;5~')
  })
  it('Alt+Esc / Alt+Tab 加 ESC 前缀', () => {
    expect(keySequence('Esc', { alt: true })).toBe('\x1b\x1b')
    expect(keySequence('Tab', { alt: true })).toBe('\x1b\t')
  })
})

describe('createModifierState 粘滞状态机', () => {
  it('单点点亮为 armed,consume 后自动清回 off', () => {
    const m = createModifierState()
    expect(m.state('ctrl')).toBe('off')
    m.tap('ctrl')
    expect(m.state('ctrl')).toBe('armed')
    expect(m.isActive('ctrl')).toBe(true)
    const mods = m.consume()
    expect(mods).toEqual({ ctrl: true, alt: false })
    expect(m.state('ctrl')).toBe('off')
  })
  it('再点取消(armed→off)', () => {
    const m = createModifierState()
    m.tap('ctrl')
    m.tap('ctrl')
    expect(m.state('ctrl')).toBe('off')
    expect(m.consume()).toEqual({ ctrl: false, alt: false })
  })
  it('长按锁定,consume 后仍保持 locked', () => {
    const m = createModifierState()
    m.lock('ctrl')
    expect(m.state('ctrl')).toBe('locked')
    m.consume()
    expect(m.state('ctrl')).toBe('locked')
    m.consume()
    expect(m.isActive('ctrl')).toBe(true)
  })
  it('锁定后再点取消(locked→off)', () => {
    const m = createModifierState()
    m.lock('alt')
    m.tap('alt')
    expect(m.state('alt')).toBe('off')
  })
  it('Ctrl armed 与 Alt locked 共存,consume 只清 armed', () => {
    const m = createModifierState()
    m.tap('ctrl')
    m.lock('alt')
    expect(m.consume()).toEqual({ ctrl: true, alt: true })
    expect(m.state('ctrl')).toBe('off')
    expect(m.state('alt')).toBe('locked')
  })
  it('reset 全清', () => {
    const m = createModifierState()
    m.tap('ctrl'); m.lock('alt')
    m.reset()
    expect(m.state('ctrl')).toBe('off')
    expect(m.state('alt')).toBe('off')
  })
})

describe('粘滞修饰驱动 keySequence(端到端组合)', () => {
  it('armed Ctrl → 下一键 a 得 ^A,之后修饰清空', () => {
    const m = createModifierState()
    m.tap('ctrl')
    expect(keySequence('a', m.consume())).toBe('\x01')
    expect(keySequence('a', m.consume())).toBe('a')
  })
  it('locked Ctrl → 连续多键都带控制码', () => {
    const m = createModifierState()
    m.lock('ctrl')
    expect(keySequence('a', m.consume())).toBe('\x01')
    expect(keySequence('e', m.consume())).toBe('\x05')
  })
})
