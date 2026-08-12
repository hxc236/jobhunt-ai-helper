/** sherpa-onnx-node 无自带类型声明：最小声明（懒加载使用，运行时检查）。 */
declare module 'sherpa-onnx-node' {
  export class OnlineRecognizer {
    constructor(config: Record<string, unknown>)
    acceptWaveform(stream: unknown, wav: Uint8Array): void
    isReady(stream: unknown): boolean
    decode(stream: unknown): void
    getResult(stream: unknown): { text: string }
  }
  export function createOnlineStream(recognizer: OnlineRecognizer): unknown
}
