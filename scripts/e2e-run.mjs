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

// npm run e2e:content-optimize:answers → 追问场景（JOBHUNT_E2E_SCENARIO=questions）
// npm run e2e:content-optimize:promotion → 大赛提升场景（JOBHUNT_E2E_SCENARIO=promotion）
// npm run e2e:content-optimize:full → 全流程冒烟（JOBHUNT_E2E_SCENARIO=full，T09）
// npm run e2e:content-optimize:real → 真实 agent 冒烟（JOBHUNT_E2E_REAL=1，T09/AC4，手动运行）
const args = process.argv.slice(2)
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
if (args.includes('--answers')) {
  env['JOBHUNT_E2E_SCENARIO'] = 'questions'
} else if (args.includes('--promotion')) {
  env['JOBHUNT_E2E_SCENARIO'] = 'promotion'
} else if (args.includes('--full')) {
  env['JOBHUNT_E2E_SCENARIO'] = 'full'
} else if (args.includes('--real')) {
  env['JOBHUNT_E2E_REAL'] = '1'
}

const result = spawnSync(electronPath, [script], {
  stdio: 'inherit',
  env
})

process.exit(result.status ?? 1)
