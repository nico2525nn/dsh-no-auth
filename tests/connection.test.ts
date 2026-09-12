import { describe, expect, it, vi } from 'vitest'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { cleanApplicationUrl, disableBrowserAuth } from '../src/connection.js'

interface FakeConnection {
  requestRejection(request: unknown): 401 | 403 | undefined
  authorizeIndex(request: unknown, response: { writeHead: (status: number) => void; end: (body?: string) => void }): boolean
  authenticatedUrl(baseUrl: string): string
  rpc: { handle: () => void; intercept: () => void }
  fetch: { register: () => void }
  createSharedFetchHandler: () => object
}

function fakeConnection(): FakeConnection {
  return {
    requestRejection: (request: unknown) => request === 'untrusted' ? 403 : 401,
    authorizeIndex: () => false,
    authenticatedUrl: baseUrl => baseUrl + '/?token=stock',
    rpc: { handle: () => {}, intercept: () => {} },
    fetch: { register: () => {} },
    createSharedFetchHandler: () => ({}),
  }
}

describe('disabled BrowserAuth adapter', () => {
  it('removes 401 and index/token gates but preserves the official 403 trust fence', () => {
    const connection = fakeConnection()
    const restore = disableBrowserAuth(connection as unknown as HostConnectionHandle)

    expect(connection.requestRejection('trusted')).toBeUndefined()
    expect(connection.requestRejection('untrusted')).toBe(403)
    const response = { writeHead: vi.fn(), end: vi.fn() }
    expect(connection.authorizeIndex('trusted', response)).toBe(true)
    expect(connection.authorizeIndex('untrusted', response)).toBe(false)
    expect(response.writeHead).toHaveBeenCalledWith(403)
    expect(connection.authenticatedUrl('https://nico.tailxxxx.ts.net')).toBe('https://nico.tailxxxx.ts.net/')

    restore()
    expect(connection.requestRejection('trusted')).toBe(401)
    expect(connection.authorizeIndex({}, response)).toBe(false)
    expect(connection.authenticatedUrl('https://nico.tailxxxx.ts.net')).toContain('token=stock')
  })
})

describe('cleanApplicationUrl', () => {
  it('cleans path, query, and fragment so auth-off handoff has no token', () => {
    expect(cleanApplicationUrl('https://example.test/old?token=x#fragment')).toBe('https://example.test/')
  })
})
