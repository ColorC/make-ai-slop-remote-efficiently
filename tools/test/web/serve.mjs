// 极简静态服务器 — 给 Playwright 端到端测试托管真实的 app/www 页面。
// 只服务文件;所有 /api/* 与 WS 由测试用例里的 page.route / routeWebSocket 拦截。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'app', 'www')
const PORT = Number(process.env.PORT || 5599)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0])
    if (p === '/') p = '/index.html'
    const full = normalize(join(ROOT, p))
    if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }
    const data = await readFile(full)
    res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream' })
    res.end(data)
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
  }
}).listen(PORT, () => console.log('lofa static server on http://localhost:' + PORT))
