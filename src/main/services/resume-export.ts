import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'

/**
 * 简历 PDF 导出（F-15/#30）：隐藏 BrowserWindow 加载 A4 HTML → printToPDF →
 * 保存对话框 → 写文件。真实 Electron 路径，不做自动化测试（手动冒烟，
 * 与 BrowserWindowFetcher 同约定）。
 */
export async function exportResumePdf(html: string, defaultName: string): Promise<string | null> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出简历 PDF',
      defaultPath: `${defaultName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || filePath === undefined || filePath === '') return null
    await writeFile(filePath, pdf)
    return filePath
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * 简历 DOCX 导出（#74）：真实可编辑 Word 文档写盘。
 * 保存对话框使用 .docx 扩展名与 Word 过滤器；取消返回 null，不创建文件。
 * 与 PDF 导出一致：隐藏 BrowserWindow 作为保存对话框父窗口。
 */
export async function exportResumeDocx(docx: Buffer, defaultName: string): Promise<string | null> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出简历 DOCX',
      defaultPath: `${defaultName}.docx`,
      filters: [{ name: 'Word 文档', extensions: ['docx'] }]
    })
    if (canceled || filePath === undefined || filePath === '') return null
    await writeFile(filePath, docx)
    return filePath
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
