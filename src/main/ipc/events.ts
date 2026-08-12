import { BrowserWindow } from 'electron'
import type { IpcEventMap, IpcEventName } from '../../shared/protocol'

/** 向所有存活窗口推送事件（主 → 渲染）。 */
export function pushEvent<E extends IpcEventName>(event: E, payload: IpcEventMap[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(event, payload)
    }
  }
}
