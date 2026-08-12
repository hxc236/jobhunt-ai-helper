import type { PingResponse } from '../../shared/protocol'

/**
 * 示例服务：ping 往返（EF-01 脚手架验收）。
 * 纯函数，无 Electron 依赖 —— vitest 可直接单测；IPC handler 仅做薄转调。
 */
export function ping(): PingResponse {
  return 'pong'
}
