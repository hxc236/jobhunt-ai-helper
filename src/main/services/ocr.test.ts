import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { ocrImage } from './ocr'

/**
 * ocrImage 单测：注入 fake spawn（不真跑 PowerShell），验证：
 * - 脚本内容处理（param 行被剥、图片路径被内联）
 * - stdout 解析（UTF-8、BOM 剥除）
 * - 非零退出码 → 拒绝
 * - ENGINE_FAIL → 拒绝
 * 真实 PowerShell + Windows.Media.Ocr 为手动冒烟（spec Testing Decisions）。
 */

function fakeSpawn(behavior: {
  code?: number
  stdout?: string
  stderr?: string
}) {
  return () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      if (behavior.stdout !== undefined) child.stdout.emit('data', Buffer.from(behavior.stdout, 'utf8'))
      if (behavior.stderr !== undefined) child.stderr.emit('data', Buffer.from(behavior.stderr, 'utf8'))
      child.emit('close', behavior.code ?? 0)
    })
    return child
  }
}

describe('ocrImage', () => {
  it('正常识别：UTF-8 文本解析（剥 BOM），拼装脚本含内联路径', async () => {
    let capturedArgs: string[] = []
    const text = await ocrImage('C:\\img\\job.png', {
      spawnFn: ((...args: unknown[]) => {
        capturedArgs = args[1] as string[] // spawn(ps, argsArray)
        return fakeSpawn({ stdout: '\uFEFF职 位 描 述\n公 司 介 绍\n' })() as never
      }) as never
    })
    expect(text).toBe('职 位 描 述\n公 司 介 绍')
    // EncodedCommand 里的脚本：无 param 行、路径内联
    const encoded = capturedArgs[capturedArgs.indexOf('-EncodedCommand') + 1]
    const script = Buffer.from(encoded as string, 'base64').toString('utf16le')
    expect(script).not.toContain('param(')
    expect(script).toContain("GetFileFromPathAsync('C:\\img\\job.png')")
    expect(capturedArgs).toContain('-Sta')
  })

  it('非零退出码 → 拒绝并带 stderr', async () => {
    await expect(
      ocrImage('x.png', {
        spawnFn: fakeSpawn({ code: 1, stderr: 'boom' }) as never
      })
    ).rejects.toThrow(/boom/)
  })

  it('ENGINE_FAIL → 拒绝（缺中文语言包）', async () => {
    await expect(
      ocrImage('x.png', {
        spawnFn: fakeSpawn({ stdout: 'ENGINE_FAIL' }) as never
      })
    ).rejects.toThrow(/中文语言包/)
  })
})
