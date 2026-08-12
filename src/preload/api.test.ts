import { describe, expect, it, vi } from 'vitest'
import { IpcChannel, IpcEvent, type IpcEventMap, type IpcEventName, type IpcInvoker } from '../shared/protocol'
import { createRendererApi, type IpcBridge } from './api'

interface FakeBridge {
  bridge: IpcBridge
  invocations: Array<{ channel: string; args: unknown[] }>
  emit: (event: string, payload: unknown) => void
  subscribed: Map<string, Array<(payload: unknown) => void>>
}

function makeFakeBridge(): FakeBridge {
  const invocations: Array<{ channel: string; args: unknown[] }> = []
  const subscribed = new Map<string, Array<(payload: unknown) => void>>()

  const bridge: IpcBridge = {
    invoke: ((channel: string, ...args: unknown[]) => {
      invocations.push({ channel, args })
      return Promise.resolve(undefined)
    }) as IpcInvoker,
    on: (channel: string, listener: (payload: unknown) => void) => {
      const list = subscribed.get(channel) ?? []
      list.push(listener)
      subscribed.set(channel, list)
      return () => {
        const idx = list.indexOf(listener)
        if (idx >= 0) list.splice(idx, 1)
      }
    }
  }

  return {
    bridge,
    invocations,
    subscribed,
    emit: (event: string, payload: unknown) => {
      for (const listener of subscribed.get(event) ?? []) listener(payload)
    }
  }
}

describe('createRendererApi（渲染侧 api 客户端）', () => {
  it('ping 映射到 IpcChannel.Ping，不带参数', async () => {
    const fake = makeFakeBridge()
    const api = createRendererApi(fake.bridge)
    await api.ping()
    expect(fake.invocations).toEqual([{ channel: IpcChannel.Ping, args: [] }])
  })

  it('settings.get 映射到 settings:get 并传 { key }', async () => {
    const fake = makeFakeBridge()
    const api = createRendererApi(fake.bridge)
    await api.settings.get('ui.theme')
    expect(fake.invocations).toEqual([{ channel: IpcChannel.SettingsGet, args: [{ key: 'ui.theme' }] }])
  })

  it('settings.set 映射到 settings:set 并传 { key, value }', async () => {
    const fake = makeFakeBridge()
    const api = createRendererApi(fake.bridge)
    await api.settings.set('ui.theme', { dark: true })
    expect(fake.invocations).toEqual([
      { channel: IpcChannel.SettingsSet, args: [{ key: 'ui.theme', value: { dark: true } }] }
    ])
  })

  it('settings.getAll 映射到 settings:get-all，不带参数', async () => {
    const fake = makeFakeBridge()
    const api = createRendererApi(fake.bridge)
    await api.settings.getAll()
    expect(fake.invocations).toEqual([{ channel: IpcChannel.SettingsGetAll, args: [] }])
  })

  it('on 订阅事件推送：收到载荷；取消订阅后不再送达', () => {
    const fake = makeFakeBridge()
    const api = createRendererApi(fake.bridge)
    const listener = vi.fn()
    const unsubscribe = api.on(IpcEvent.SettingsChanged, listener)

    expect(fake.subscribed.has(IpcEvent.SettingsChanged)).toBe(true)

    const payload: IpcEventMap[typeof IpcEvent.SettingsChanged] = { key: 'k', value: 1 }
    fake.emit(IpcEvent.SettingsChanged, payload)
    expect(listener).toHaveBeenCalledWith(payload)

    unsubscribe()
    fake.emit(IpcEvent.SettingsChanged, { key: 'k', value: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('on 仅接受协议内事件名（类型化：事件名与载荷一一对应）', () => {
    const fake = makeFakeBridge()
    const api = createRendererApi(fake.bridge)
    // 编译期约束：事件名必须是 IpcEventName，载荷类型随事件推导
    const events: IpcEventName[] = [IpcEvent.AgentDelta, IpcEvent.AgentStatus, IpcEvent.InterviewTurnEnd, IpcEvent.CrawlProgress]
    for (const event of events) {
      api.on(event, () => {})
      expect(fake.subscribed.has(event)).toBe(true)
    }
  })
})
