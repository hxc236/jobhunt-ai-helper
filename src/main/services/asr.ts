import { join } from 'node:path'
import type { AsrStatus } from '../../shared/types'

/** sherpa OnlineRecognizer 最小结构（运行时接口，见 sherpa-onnx-node.d.ts）。 */
interface SherpaRecognizer {
  acceptWaveform(stream: unknown, wav: Uint8Array): void
  isReady(stream: unknown): boolean
  decode(stream: unknown): void
  getResult(stream: unknown): { text: string }
}



/**
 * 语音识别服务（F-26/#40）：PTT 录音（渲染层 MediaRecorder）→ 转写 → 文本入面试循环。
 * - provider 抽象（同 AgentProvider 模式）：fake 供测试、SherpaAsrProvider 真实实现；
 * - 降级：模型缺失/未就绪 → AsrNotReadyError（UI 提示文字输入兜底，spec 降级策略）；
 * - 真实识别不做自动化测试（手动冒烟：模型就绪时 PTT 说话 → 文本回填）。
 */

export interface AsrProvider {
  readonly name: string
  /** 就绪状态（模型文件存在等）；未就绪给出原因（降级提示文案）。 */
  getStatus(): AsrStatus
  /** wav PCM 16k 单声道 → 识别文本。 */
  transcribe(wav: Uint8Array): Promise<string>
  dispose(): void
}

export class AsrNotReadyError extends Error {
  readonly code = 'ASR_NOT_READY' as const
  constructor(message: string) {
    super(message)
    this.name = 'AsrNotReadyError'
  }
}

export class AsrService {
  private recording = false

  constructor(private readonly provider: AsrProvider) {}

  /** 就绪状态（渲染层据此显示 PTT 按钮或降级文字输入提示）。 */
  getStatus(): AsrStatus {
    return this.provider.getStatus()
  }

  /** PTT 按下：标记录音中（校验就绪）。 */
  startRecording(): void {
    if (!this.provider.getStatus().ready) {
      throw new AsrNotReadyError(this.provider.getStatus().reason ?? '语音识别未就绪——请使用文字输入')
    }
    this.recording = true
  }

  /** PTT 松开：渲染层 MediaRecorder 产物（wav）→ 转写文本。 */
  async stopRecording(wav: Uint8Array): Promise<string> {
    if (!this.recording) throw new AsrNotReadyError('未在录音状态——请按住说话')
    this.recording = false
    return this.provider.transcribe(wav)
  }

  dispose(): void {
    this.provider.dispose()
  }
}

/**
 * 真实 sherpa-onnx 实现（ADR-0007）：流式识别器 + Silero VAD 切句（静音 ≥1s）。
 * 模型目录：resources/sherpa-onnx/{encoder,decoder,joiner,tokens}.onnx（zipformer 流式中文）。
 * 模型缺失 → ready=false（降级）；加载失败同样降级并记录原因。
 */
export class SherpaAsrProvider implements AsrProvider {
  readonly name = 'sherpa-onnx'
  private status: AsrStatus
  private recognizer: SherpaRecognizer | null = null

  constructor(private readonly modelDir: string) {
    this.status = this.probe()
  }

  getStatus(): AsrStatus {
    return this.status
  }

  async transcribe(wav: Uint8Array): Promise<string> {
    if (!this.status.ready) throw new AsrNotReadyError(this.status.reason ?? '语音识别未就绪')
    try {
      // 懒加载原生模块（测试/降级路径不触碰）
      const sherpa = await import('sherpa-onnx-node')
      if (this.recognizer === null) {
        this.recognizer = new sherpa.OnlineRecognizer({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: join(this.modelDir, 'encoder.onnx'),
              decoder: join(this.modelDir, 'decoder.onnx'),
              joiner: join(this.modelDir, 'joiner.onnx')
            },
            tokens: join(this.modelDir, 'tokens.txt'),
            numThreads: 2,
            provider: 'cpu'
          },
          enableEndpoint: true, // 端点检测：静音 ≥1s 切句（VAD 语义）
          endpointConfig: {
            rule1MustTrailingSilence: true,
            rule1MinTrailingSilence: 1.0,
            rule2MinTrailingSilence: 1.0,
            rule3MinUtteranceLength: 0
          }
        })
      }
      const stream = sherpa.createOnlineStream(this.recognizer)
      this.recognizer.acceptWaveform(stream, wav)
      while (this.recognizer.isReady(stream)) {
        this.recognizer.decode(stream)
      }
      const text = this.recognizer.getResult(stream).text.trim()
      ;(stream as { free(): void }).free()
      return text
    } catch (err) {
      throw new AsrNotReadyError(`语音识别失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  dispose(): void {
    this.recognizer = null
  }

  private probe(): AsrStatus {
    const required = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
    const missing = required.filter((f) => !exists(join(this.modelDir, f)))
    if (missing.length > 0) {
      return {
        ready: false,
        reason: `语音模型缺失（${missing.join('/')}）——已降级为文字输入，请将模型放入 resources/sherpa-onnx`
      }
    }
    return { ready: true }
  }
}

function exists(filePath: string): boolean {
  try {
    return require('node:fs').existsSync(filePath)
  } catch {
    return false
  }
}
