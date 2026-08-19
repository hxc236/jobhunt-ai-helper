import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderHtmlTemplate } from './pdf-raster-template'

/**
 * #84 回归测试：electron-vite 5 esmShimPlugin（源自 unjs/unbuild）用模板盲正则
 * ESMStaticImportRe 扫描构建产物中的静态 import 语句，在其后注入含
 * import __cjs_mod__ from 'node:module' 的 CommonJS shim。
 *
 * 模板字符串里的静态 import 行会被误判为真实语句 → shim 污染进 render.html →
 * 栅格化窗口加载时 node:module 被 CORS 拦截 → 内联脚本失败 → executeJavaScript
 * 抛错 → Electron 弹「Script failed to execute」对话框（扫描 PDF 导入必现）。
 *
 * 该正则逐字复制自 node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js
 * （electron-vite 5.0.0）；若上游修改本测试需同步核对。
 */
const ESMStaticImportRe =
  /(?<=\s|^|;)import\s*([\s"']*(?<imports>[\p{L}\p{M}\w\t\n\r $*,/{}@.]+)from\s*)?["']\s*(?<specifier>(?<="\s*)[^"]*[^\s"](?=\s*")|(?<='\s*)[^']*[^\s'](?=\s*'))\s*["'][\s;]*/gmu

describe('pdf-raster render.html 模板（#84）', () => {
  it('模板内不含会被 electron-vite esmShimPlugin 误判的静态 import 语句', () => {
    expect(renderHtmlTemplate()).not.toMatch(ESMStaticImportRe)
  })

  it('pdfjs 以动态导入加载（import( 后跟括号，正则不匹配）', () => {
    const tpl = renderHtmlTemplate()
    expect(tpl).toContain("const pdfjs = await import('./pdf.mjs')")
    expect(tpl).not.toContain("import * as pdfjs from")
  })

  it('模板不含 node: 模块说明符（污染标志）', () => {
    expect(renderHtmlTemplate()).not.toContain('node:module')
    expect(renderHtmlTemplate()).not.toContain('CommonJS Shims')
  })

  it('模板仍暴露栅格化所需的三要素', () => {
    const tpl = renderHtmlTemplate()
    expect(tpl).toContain('window.__openPdf')
    expect(tpl).toContain('window.__renderPdfPage')
    expect(tpl).toContain('window.__closePdf')
    expect(tpl).toContain('pdf.worker.mjs')
  })
})

/**
 * 第二道防线：对真实构建产物 out/main/index.js 的模板区做检查。
 * 仅在产物存在时运行（electron-vite build 之后）；未构建则跳过。
 */
const outMain = join(process.cwd(), 'out', 'main', 'index.js')
const built = existsSync(outMain)
describe.skipIf(!built)('构建产物 render.html 模板区（#84）', () => {
  it('out/main/index.js 的模板区未被注入 CommonJS shim', () => {
    const bundle = readFileSync(outMain, 'utf8')
    const start = bundle.indexOf('jobhunt-ocr-raster')
    // 模板区：renderHtmlPath 附近起，至 pdf.worker.mjs 首次出现止
    const end = bundle.indexOf('pdf.worker.mjs', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const region = bundle.slice(start, end + 20)
    expect(region).not.toContain('node:module')
    expect(region).not.toContain('CommonJS Shims')
  })
})
