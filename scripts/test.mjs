// 测试运行器：用 Electron 内置 Node 跑 vitest（ELECTRON_RUN_AS_NODE=1）。
// 原因：better-sqlite3 按 Electron ABI（本仓库 .npmrc: runtime=electron）安装，
// 普通 `node vitest` 会因 NODE_MODULE_VERSION 不匹配而无法加载原生模块；
// Electron-as-Node 与主进程运行的是同一份二进制，测试即与运行时一致。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron') // electron 包导出二进制路径
const vitestEntry = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))

const result = spawnSync(electronPath, [vitestEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

process.exit(result.status ?? 1)
