import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const runtimeRoot = resolve(process.cwd(), '../../../app/www')
const jsRoot = resolve(runtimeRoot, 'js')

describe('LOFA single-frontend architecture gate', () => {
  it('ships only shell, connection, diagnostics and bridge modules', () => {
    const modules = readdirSync(jsRoot).filter((name) => name.endsWith('.js')).sort()
    expect(modules).toEqual([
      'app.js',
      'browserView.js',
      'core.js',
      'remote.js',
      'remoteState.js',
      'router.js',
      'settingsView.js',
      'ui.js',
    ])
  })

  it('contains no local business view, renderer, state or generic native execution', () => {
    const source = readdirSync(jsRoot)
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(resolve(jsRoot, name), 'utf8'))
      .join('\n')
    expect(source).not.toMatch(/legacyBusinessUi|eval\s*\(|new\s+Terminal\s*\(|\/api\/cc\/(chat\/)?sessions/)
    expect(source).not.toMatch(/from\s+['"].*?(sessions|chat|term|review|projects|notes)(View|State|Render)?\.js['"]/) 
  })

  it('packages three shell surfaces and no local business navigation', () => {
    const html = readFileSync(resolve(runtimeRoot, 'index.html'), 'utf8')
    expect(html.match(/<section class="view"/g)).toHaveLength(3)
    expect(html).toContain('id="browserView"')
    expect(html).toContain('id="meView"')
    expect(html).toContain('id="connectView"')
    expect(html).not.toMatch(/bottomNav|sessionsView|chatView|termView|reviewView|projectsView|notesView|xterm/)
  })

  it('keeps the retired terminal WIP outside the APK runtime', () => {
    const archive = resolve(process.cwd(), '../../../docs/legacy-terminal-evidence')
    expect(readdirSync(archive).sort()).toEqual([
      'README.md', 'term.css', 'term.spec.js', 'termKeys.js', 'termKeys.test.js', 'termView.js',
    ])
  })
})
