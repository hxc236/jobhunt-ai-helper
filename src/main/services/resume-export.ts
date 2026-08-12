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
