import { describe, expect, it } from 'vitest'
import { AsrNotReadyError, AsrService, type AsrProvider } from './asr'
import type { AsrStatus } from '../../shared/types'

/** 假 ASR provider：可编程文本/就绪状态；记录调用。 */
function makeProvider(options: { ready?: boolean; reason?: string; text?: string } = {}): AsrProvider & {
  transcribed: number
} {
  return {
    name: 'fake-asr',
    transcribed: 0,
    getStatus(): AsrStatus {
      return { ready: options.ready ?? true, reason: options.reason }
    },
    async transcribe() {
      this.transcribed++
      return options.text ?? '这是识别文本'
    },
    dispose() {}
  }
}

describe('AsrService（F-26/#40）', () => {
  it('PTT 流程：startRecording（就绪校验）→ stopRecording(wav) 返回识别文本', async () => {
    const provider = makeProvider({ text: '我熟悉 Java 并发' })
    const asr = new AsrService(provider)

    expect(asr.getStatus().ready).toBe(true)
    asr.startRecording()
    const text = await asr.stopRecording(new Uint8Array([1, 2, 3]))
    expect(text).toBe('我熟悉 Java 并发')
    expect(provider.transcribed).toBe(1)
  })

  it('未就绪（缺模型）→ startRecording 抛 AsrNotReadyError，reason 透传（降级提示文案）', () => {
    const provider = makeProvider({ ready: false, reason: '语音模型缺失——已降级为文字输入' })
    const asr = new AsrService(provider)

    expect(asr.getStatus()).toEqual({ ready: false, reason: '语音模型缺失——已降级为文字输入' })
    expect(() => asr.startRecording()).toThrowError(AsrNotReadyError)
    expect(() => asr.startRecording()).toThrowError(/降级为文字输入/)
  })

  it('未标记录音就 stopRecording → 报错（防误触）', async () => {
    const provider = makeProvider()
    const asr = new AsrService(provider)
    await expect(asr.stopRecording(new Uint8Array())).rejects.toThrowError(/按住说话/)
    expect(provider.transcribed).toBe(0)
  })

  it('录音中重复 startRecording → 允许（保持录音态）', () => {
    const provider = makeProvider()
    const asr = new AsrService(provider)
    asr.startRecording()
    asr.startRecording()
    expect(() => asr.startRecording()).not.toThrow()
  })

  it('stopRecording 后再次 stop → 报错（PTT 状态机复位）', async () => {
    const provider = makeProvider()
    const asr = new AsrService(provider)
    asr.startRecording()
    await asr.stopRecording(new Uint8Array())
    await expect(asr.stopRecording(new Uint8Array())).rejects.toThrowError(/按住说话/)
  })
})
