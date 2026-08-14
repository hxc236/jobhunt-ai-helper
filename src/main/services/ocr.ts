import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Windows 系统 OCR 服务（issue #67）：调 Windows.Media.Ocr 识别图片文字。
 *
 * 方案决策（grill Q4）：用 Windows 自带 OCR（零新依赖、中文质量最好），
 * 通过 PowerShell 脚本（resources/win-ocr.ps1）走 WinRT 互操作。
 * 实测：zh-Hans-CN 引擎可用，中文识别质量好（见 .checkpoint/ocr-test-out.txt）。
 *
 * 只支持 Windows（非 Windows 环境抛错，调用方提示用户）。
 */

export interface OcrServiceOptions {
  /** 测试 seam：替代 spawn（默认 node:child_process spawn）。 */
  spawnFn?: typeof spawn
  /** PowerShell 可执行名（默认 powershell.exe）。 */
  powershell?: string
}

/** 调 Windows.Media.Ocr 识别图片 → 文本（UTF-8，逐行）。 */
export async function ocrImage(imagePath: string, options: OcrServiceOptions = {}): Promise<string> {
  // vitest 直跑源码时 import.meta.dirname = src/main/services（resources 在项目根）；
  // electron-vite 打包后 = out/main（resources 在 out 同级）。两处都探测。
  const scriptPath = [
    join(import.meta.dirname, '../../resources/win-ocr.ps1'), // 打包后 out/main → 项目根 resources
    join(process.cwd(), 'resources/win-ocr.ps1') // 源码直跑（vitest）
  ].find((p) => {
    try {
      readFileSync(p)
      return true
    } catch {
      return false
    }
  }) as string
  const script = readFileSync(scriptPath, 'utf8')
  const ps = options.powershell ?? 'powershell.exe'

  // PS 5.1 限制：-EncodedCommand 不接受位置参数；且 param 块会把末尾注入的
  // 赋值变只读（实测 AggregateException）。故去掉 param 行、图片路径字面量
  // 内联进脚本（方案 B 实测成功，见 .checkpoint/ocr-compare.cjs）。
  const inline = script
    .replace(/param\(\[string\]\$ImagePath\)\s*\n/, '')
    .replace(
      'Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath))',
      `Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${imagePath}'))`
    )
  const encoded = Buffer.from(inline, 'utf16le').toString('base64')

  return new Promise((resolve, reject) => {
    const child = (options.spawnFn ?? spawn)(ps, [
      '-NoProfile',
      '-NonInteractive',
      '-Sta', // WinRT 需要 STA 线程（-EncodedCommand 默认 MTA，会抛 AggregateException）
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded
    ])
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => stdout.push(d))
    child.stderr.on('data', (d: Buffer) => stderr.push(d))
    child.on('error', (err) => reject(new Error(`OCR 启动失败：${err.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`OCR 失败（退出码 ${code}）：${Buffer.concat(stderr).toString('utf8').trim()}`))
        return
      }
      const text = Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '').trim()
      if (text === '' || text === 'ENGINE_FAIL') {
        reject(new Error('OCR 引擎不可用——请确认系统已安装中文语言包'))
        return
      }
      resolve(text)
    })
  })
}
