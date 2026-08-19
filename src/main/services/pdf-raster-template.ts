/**
 * 栅格化窗口的 render.html 模板（独立模块：不 import electron，供 vitest 直接回归测试）。
 *
 * #84 修复：内联脚本必须用「动态导入」await import('./pdf.mjs')，不能写静态
 * import ... from 语句。原因：electron-vite 5 的 esmShimPlugin（源自 unjs/unbuild）
 * 用模板盲正则 ESMStaticImportRe 扫描构建产物里的静态 import 并在其后注入
 * CommonJS shim（含 import __cjs_mod__ from 'node:module'）。模板字符串里的
 * import 行会被误判为真实语句，导致 shim 被注入进模板 → 浏览器加载 render.html
 * 时 node:module 被 CORS 拦截 → 内联脚本整体失败 → __openPdf 未定义 →
 * executeJavaScript 抛错 → Electron 弹「Script failed to execute」对话框。
 * 动态导入 import(...) 后跟括号而非 from/引号，不匹配该正则。
 */
export function renderHtmlTemplate(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<script type="module">
// 动态导入（勿改回 import * as——electron-vite esmShimPlugin 正则会污染模板，见文件头注释）
const pdfjs = await import('./pdf.mjs')
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
}
