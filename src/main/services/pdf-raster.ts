import { BrowserWindow, protocol, net, app } from 'electron'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * PDF 逐页栅格化（#81）：隐藏 BrowserWindow + pdfjs（浏览器 canvas）→ PNG。
 *
 * - pdfjs 的 Node 构建无 canvas，故用隐藏窗口加载 pdfjs（真实 Chromium canvas）；
 * - pdfjs 文件经自定义协议 ocr-raster://lib/ 提供（node_modules/pdfjs-dist/legacy/build），
 *   render.html 与其同源，动态 import './pdf.mjs'；worker 以 blob URL 提供；
 * - PDF 文档缓存在窗口内（open → render 多页 → close），避免逐页重复加载；
 * - 真实 Windows OCR 冒烟在 scripts/ocr-smoke.mjs（#79）与 #83 Computer Use 验收覆盖，
 *   本模块不做跨平台单元测试（与 printToPDF 同约定：真实 Electron 路径手动冒烟）。
 */

const PROTOCOL = 'ocr-raster'

// 标准 scheme（带 origin）才能跨模块加载/fetch：必须在 app ready 前注册
protocol.registerSchemesAsPrivileged([
  {
    scheme: PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

let protocolRegistered = false
let rasterWindow: BrowserWindow | null = null

function pdfjsDir(): string {
  // 开发/打包后 node_modules 在应用根；electron-vite 外部化 dependencies，pdfjs 不打包进 bundle
  return join(app.getAppPath(), 'node_modules', 'pdfjs-dist', 'legacy', 'build')
}

function renderHtmlPath(): string {
  const dir = join(tmpdir(), 'jobhunt-ocr-raster')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'render.html')
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<script type="module">
import * as pdfjs from './pdf.mjs'
// worker 用 blob URL（自定义协议建 Worker 受限；首次调用时惰性初始化，避免顶层 await 阻塞函数挂载）
let workerReady = null
const ensureWorker = () => {
  workerReady ??= (async () => {
    const wt = await (await fetch('./pdf.worker.mjs')).text()
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wt], { type: 'text/javascript' }))
  })()
  return workerReady
}
let cachedDoc = null
window.__openPdf = async (pdfB64) => {
  await ensureWorker()
  const bin = atob(pdfB64)
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
  cachedDoc = await pdfjs.getDocument({ data }).promise
  return cachedDoc.numPages
}
window.__renderPdfPage = async (pageNo, scale) => {
  if (cachedDoc === null) throw new Error('PDF 未打开')
  const page = await cachedDoc.getPage(pageNo)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  return canvas.toDataURL('image/png')
}
window.__closePdf = async () => {
  if (cachedDoc !== null) { await cachedDoc.destroy(); cachedDoc = null }
  return true
}
</script></body></html>`
  writeFileSync(file, html)
  return file
}

function ensureProtocol(): void {
  if (protocolRegistered) return
  const htmlFile = renderHtmlPath()
  protocol.handle(PROTOCOL, (request) => {
    const url = new URL(request.url)
    const rel = url.pathname.replace(/^\/+/, '')
    if (rel === 'render.html') {
      return net.fetch(pathToFileURL(htmlFile).toString())
    }
    return net.fetch(pathToFileURL(join(pdfjsDir(), rel)).toString())
  })
  protocolRegistered = true
}

async function ensureWindow(): Promise<BrowserWindow> {
  if (rasterWindow !== null && !rasterWindow.isDestroyed()) return rasterWindow
  ensureProtocol()
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  await win.loadURL(`${PROTOCOL}://lib/render.html`)
  rasterWindow = win
  win.on('closed', () => {
    rasterWindow = null
  })
  return win
}

/** 在栅格化窗口中打开 PDF，返回页数（后续 renderRasterPage/closeRasterPdf 用）。 */
export async function openPdfInRasterWindow(pdfPath: string): Promise<number> {
  const win = await ensureWindow()
  const pdfB64 = readFileSync(pdfPath).toString('base64')
  const numPages = await win.webContents.executeJavaScript(`window.__openPdf('${pdfB64}')`, true)
  if (typeof numPages !== 'number' || numPages < 1) {
    throw new Error(`PDF 打开失败：${pdfPath}`)
  }
  return numPages
}

/** 渲染已打开 PDF 的第 pageNo 页（1-based）→ PNG Buffer。 */
export async function renderRasterPage(pageNo: number, scale = 2): Promise<Buffer> {
  const win = rasterWindow
  if (win === null || win.isDestroyed()) throw new Error('栅格化窗口未打开 PDF')
  const result = await win.webContents.executeJavaScript(`window.__renderPdfPage(${pageNo}, ${scale})`, true)
  if (typeof result !== 'string' || !result.startsWith('data:image/png;base64,')) {
    throw new Error(`PDF 第 ${pageNo} 页渲染失败（未返回 PNG）`)
  }
  return Buffer.from(result.slice('data:image/png;base64,'.length), 'base64')
}

/** 释放栅格化窗口中的 PDF（OCR 流程结束调用）。 */
export async function closeRasterPdf(): Promise<void> {
  const win = rasterWindow
  if (win === null || win.isDestroyed()) return
  await win.webContents.executeJavaScript('window.__closePdf()', true).catch(() => undefined)
}

/** 释放栅格化窗口（应用退出前调用）。 */
export function disposeRasterWindow(): void {
  if (rasterWindow !== null && !rasterWindow.isDestroyed()) rasterWindow.destroy()
  rasterWindow = null
}
