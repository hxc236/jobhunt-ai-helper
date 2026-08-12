import { describe, expect, it } from 'vitest'
import { ping } from './ping'

describe('ping service', () => {
  it('returns pong', () => {
    expect(ping()).toBe('pong')
  })
})
