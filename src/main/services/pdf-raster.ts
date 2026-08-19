import { BrowserWindow, protocol, net, app } from 'electron'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderHtmlTemplate } from './pdf-raster-template'

/**
 * PDF 逐页栅格化（#81）：隐藏 BrowserWindow + pdfjs（浏览器 canvas）→ PNG。
 *
 * - pdfjs 的 Node 构建无 canvas，故用隐藏窗口加载 pdfjs（真实 Chromium canvas）；
 * - pdfjs 文件经自定义协议 ocr-raster://lib/ 提供（node_modules/pdfjs-dist/legacy/build），
 *   render.html 与其同源，动态 import './pdf.mjs'；worker 以 blob URL 提供；
 * - 模板见 pdf-raster-template.ts（#84：必须动态导入，防 electron-vite 正则污染，回归测试覆盖）。
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
  writeFileSync(file, renderHtmlTemplate())
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
  await waitForRasterReady(win) // #84 遗留：loadURL 后模块脚本（含顶层 await import）可能尚未求值完，executeJavaScript 会过早失败
  rasterWindow = win
  win.on('closed', () => {
    rasterWindow = null
  })
  return win
}

/**
 * 等待栅格化窗口就绪（内联 module 脚本执行完、window.__openPdf 已挂载）。
 * loadURL 的 did-finish-load 与含顶层 await 的模块脚本求值存在竞态（实测首次导入偶发
 * 『Script failed to execute』），故轮询探测；超时报明确错误而非 Electron 原生对话框。
 */
async function waitForRasterReady(win: BrowserWindow, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await win.webContents
      .executeJavaScript('typeof window.__openPdf === \'function\'', true)
      .catch(() => false)
    if (ok) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('栅格化窗口初始化超时（render.html 脚本未就绪）')
}

/** 在栅格化窗口中打开 PDF，返回页数（后续 renderRasterPage/closeRasterPdf 用）。 */
export async function openPdfInRasterWindow(pdfPath: string): Promise<number> {
  const win = await ensureWindow()
  const pdfB64 = readFileSync(pdfPath).toString('base64')
  const numPages = await win.webContents
    .executeJavaScript(`window.__openPdf('${pdfB64}')`, true)
    .catch((err: unknown) => {
      throw new Error(`栅格化窗口打开 PDF 失败：${err instanceof Error ? err.message : String(err)}`)
    })
  if (typeof numPages !== 'number' || numPages < 1) {
    throw new Error(`PDF 打开失败：${pdfPath}`)
  }
  return numPages
}

/** 渲染已打开 PDF 的第 pageNo 页（1-based）→ PNG Buffer。 */
export async function renderRasterPage(pageNo: number, scale = 2): Promise<Buffer> {
  const win = rasterWindow
  if (win === null || win.isDestroyed()) throw new Error('栅格化窗口未打开 PDF')
  const result = await win.webContents
    .executeJavaScript(`window.__renderPdfPage(${pageNo}, ${scale})`, true)
    .catch((err: unknown) => {
      throw new Error(`PDF 第 ${pageNo} 页渲染失败：${err instanceof Error ? err.message : String(err)}`)
    })
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
