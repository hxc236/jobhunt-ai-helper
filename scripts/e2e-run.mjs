// E2E 运行器：与 scripts/test.mjs 同理，用 Electron 内置 Node 跑 E2E 脚本。
// 原因：E2E 脚本要读 SQLite（better-sqlite3 按 Electron ABI 安装），普通 node 无法加载；
// Electron-as-Node 与主进程同一二进制，落库断言与运行时一致。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const electronPath = require('electron') // electron 包导出二进制路径
const script = fileURLToPath(new URL('./e2e-content-optimize.mjs', import.meta.url))

const result = spawnSync(electronPath, [script, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

process.exit(result.status ?? 1)
