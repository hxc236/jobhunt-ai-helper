import type { RendererApi } from '../shared/protocol'

declare global {
  interface Window {
    api: RendererApi
  }
}

export {}
