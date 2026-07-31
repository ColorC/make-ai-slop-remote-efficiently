import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5599/test-remote'

async function setupRoutes(page) {
  const json = (route, body, status = 200) => route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })

  await page.route('**/api/healthz', (route) => json(route, { ok: true }))
  await page.route('**/api/android/register', (route) => json(route, { ok: true }))
  await page.route('**/api/android/log', (route) => json(route, { ok: true }))
  await page.route('**/api/android/apk/version', (route) => json(route, { manifest: null }))
  await page.route('**/api/android/commands/poll**', (route) => json(route, { commands: [] }))
  await page.route('**/lofa-config.json', (route) => json(route, { code: null }))
  await page.route('**/api/boss-sight/reviewstage/_stats', (route) => json(route, { by_status: { pending: 0 }, pushed_unread: 0 }))
  await page.route('**/api/boss-sight/residents', (route) => json(route, { residents: [] }))
  await page.route('**/api/cc/chat/sessions', (route) => json(route, { items: [] }))
  await page.route('**/api/cc/chat/active', (route) => json(route, {}))
  await page.route('**/api/cc/sessions**', (route) => json(route, { items: [], recoverable: [] }))

  await page.route('**/test-remote/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/child.html')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>Child page</title></head><body><h1 id="child">Child page</h1></body></html>',
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><title>Dashboard</title><style>
        html,body{margin:0;height:100%;font:14px sans-serif}.dashboard{height:100%;display:flex;flex-direction:column}
        .dashboard-tabs{height:40px;display:flex;background:#18202b}.dashboard-tab{color:white;background:transparent;border:0;padding:0 14px}.dashboard-tab.active{background:#334155}.dashboard-close{margin-left:8px}
        .dashboard-pages{position:relative;flex:1}.dashboard-page{position:absolute;inset:0;display:none}.dashboard-page.active{display:block}.dashboard-page-frame{width:100%;height:100%;border:0}
      </style></head><body><div class="dashboard">
        <div class="dashboard-tabs"><button class="dashboard-tab active" data-id="home">Dashboard</button></div>
        <div class="dashboard-pages"><div class="dashboard-page active" data-id="home"><input id="keep" value="preserved state"><a id="open-child" href="/test-remote/child.html" target="_blank">Open child</a></div></div>
      </div><script>
        document.documentElement.dataset.omniWebTabHost='1';
        const tabs=document.querySelector('.dashboard-tabs'); const pages=document.querySelector('.dashboard-pages'); let seq=0;
        function activate(id){document.querySelectorAll('.dashboard-tab').forEach(x=>x.classList.toggle('active',x.dataset.id===id));document.querySelectorAll('.dashboard-page').forEach(x=>x.classList.toggle('active',x.dataset.id===id));}
        function openTab(url,title){
          const id='web-'+(++seq); const tab=document.createElement('button'); tab.className='dashboard-tab'; tab.dataset.id=id; tab.textContent=title||new URL(url).hostname;
          const close=document.createElement('span'); close.className='dashboard-close'; close.textContent='?'; close.onclick=(e)=>{e.stopPropagation();tab.remove();document.querySelector('.dashboard-page[data-id="'+id+'"]').remove();activate('home')}; tab.appendChild(close); tab.onclick=()=>activate(id); tabs.appendChild(tab);
          const page=document.createElement('div');page.className='dashboard-page';page.dataset.id=id;const frame=document.createElement('iframe');frame.className='dashboard-page-frame';frame.src=url;page.appendChild(frame);pages.appendChild(page);activate(id);
        }
        window.addEventListener('message',(event)=>{if(event.data&&event.data.type==='omni:open-web-tab')openTab(event.data.url,event.data.title)});
        document.addEventListener('click',(event)=>{const a=event.target.closest&&event.target.closest('a[target="_blank"]');if(!a)return;event.preventDefault();openTab(a.href,a.textContent)},true);
      </script></body></html>`,
    })
  })
}

test('LOFA is a chrome-free host and Dashboard owns the only tab strip', async ({ page, context }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error && error.message || error)))
  await setupRoutes(page)
  await page.goto('/')
  await page.locator('#browserView').waitFor({ state: 'attached' })
  await page.evaluate(async (base) => {
    const core = await import('/js/core.js')
    const browser = await import('/js/browserView.js')
    core.store.base = base
    await browser.openHome()
  }, BASE)

  const dashboard = page.frameLocator('.browser-frame')
  await expect(page.locator('#browserView')).toHaveClass(/show/)
  await expect(page.locator('.browser-frame')).toHaveCount(1)
  await expect(page.locator('.browser-chrome')).toHaveCount(0)
  await expect(page.locator('.browser-tab')).toHaveCount(0)
  await expect(dashboard.locator('.dashboard-tab')).toHaveCount(1)
  await expect(dashboard.locator('#keep')).toHaveValue('preserved state')
  await expect(page.locator('#bottomNav')).not.toHaveClass(/show/)
  await expect.poll(() => page.locator('#app').evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('0px')

  await dashboard.locator('#open-child').click()
  await expect(dashboard.locator('.dashboard-tab')).toHaveCount(2)
  await expect(dashboard.frameLocator('.dashboard-page.active iframe').locator('#child')).toHaveText('Child page')
  expect(context.pages()).toHaveLength(1)

  await dashboard.locator('.dashboard-tab').first().click()
  await expect(dashboard.locator('#keep')).toHaveValue('preserved state')
  await dashboard.locator('.dashboard-tab').nth(1).locator('.dashboard-close').click()
  await expect(dashboard.locator('.dashboard-tab')).toHaveCount(1)

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lofa:new-window', { detail: { url: '/test-remote/child.html', title: 'Android popup' } })))
  await expect(dashboard.locator('.dashboard-tab')).toHaveCount(2)
  await expect(dashboard.frameLocator('.dashboard-page.active iframe').locator('#child')).toHaveText('Child page')
  expect(context.pages()).toHaveLength(1)

  await page.evaluate(() => {
    window.__externalOpened = []
    Object.defineProperty(window, 'Capacitor', {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        Plugins: {
          ExternalBrowser: {
            open: async ({ url }) => { window.__externalOpened.push(url) },
          },
        },
      },
    })
    window.dispatchEvent(new CustomEvent('lofa:new-window', {
      detail: { url: 'https://example.com/public', title: 'Public site' },
    }))
  })
  await expect.poll(() => page.evaluate(() => window.__externalOpened)).toEqual(['https://example.com/public'])
  await expect(dashboard.locator('.dashboard-tab')).toHaveCount(2)
  expect(context.pages()).toHaveLength(1)
  expect(errors).toEqual([])
})
