import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ocrImage } from './ocr'
import { closeRasterPdf, openPdfInRasterWindow, renderRasterPage } from './pdf-raster'

/**
 * 扫描型 PDF 的 OCR adapter（#81）：栅格化 + Windows 中文 OCR 逐页识别。
 * - open：pdfjs 打开 PDF（页数）；ocrPage：隐藏窗口栅格化第 pageNo 页 → 临时 PNG → 系统 OCR；
 * - 取消检查点：栅格化完成后、OCR 前检查 isCancelled，取消则返回空文本（调用方终止流程）；
 * - 自动化测试注入替身（不触真实渲染/OCR）；本文件为真实实现，Windows 冒烟覆盖。
 */

/** OCR adapter 契约（resume-import 注入面；测试用替身）。 */
export interface PdfOcrAdapter {
  /** 打开 PDF，返回页数。 */
  open(filePath: string): Promise<{ numPages: number }>
  /** 渲染第 pageNo 页（1-based）并 OCR → 文本；isCancelled 为 true 时应尽快返回空串。 */
  ocrPage(filePath: string, pageNo: number, isCancelled: () => boolean): Promise<string>
  /** 释放资源。 */
  dispose(): Promise<void>
}

/** 真实实现：隐藏窗口 pdfjs 栅格化 + Windows.Media.Ocr（需中文语言包，缺省时抛明确错误）。 */
export class WindowsPdfOcrAdapter implements PdfOcrAdapter {
  async open(filePath: string): Promise<{ numPages: number }> {
    const numPages = await openPdfInRasterWindow(filePath)
    return { numPages }
  }

  async ocrPage(_filePath: string, pageNo: number, isCancelled: () => boolean): Promise<string> {
    const png = await renderRasterPage(pageNo)
    if (isCancelled()) return ''
    const tmpFile = join(tmpdir(), `jobhunt-ocr-page-${pageNo}-${Date.now()}.png`)
    writeFileSync(tmpFile, png)
    try {
      return await ocrImage(tmpFile)
    } finally {
      try {
        unlinkSync(tmpFile)
      } catch {
        // 清理失败不阻塞（临时文件）
      }
    }
  }

  async dispose(): Promise<void> {
    await closeRasterPdf()
  }
}
