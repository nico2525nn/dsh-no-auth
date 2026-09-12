import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  apply,
  normalizeAdvertisedUrl,
  WEB_STARTUP_SERVICE,
  type WebStartupValues,
} from '../src/startup.js'

interface ParseResult {
  values: WebStartupValues | undefined
  exits: number[]
}

function parse(args: string[], config?: Parameters<typeof apply>[1]): ParseResult {
  const ctx = new Context()
  const exits: number[] = []
  provideCmdline(ctx, { args, exit: code => exits.push(code) })
  apply(ctx, config)
  return { values: ctx.get(WEB_STARTUP_SERVICE), exits }
}

describe('startup value validation', () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps stock defaults and BrowserAuth enabled', () => {
    expect(parse([])).toEqual({
      values: {
        openBrowser: true,
        trustedHosts: [],
        browserAuth: 'dsh',
        advertiseUrl: null,
        remoteSettings: false,
        allowUnauthenticatedRemote: false,
      },
      exits: [],
    })
  })

  it('accepts the WebServer-supported all-interface bind, fixed port, and port zero', () => {
    expect(parse([
      '--host', '0.0.0.0',
      '--port', '0',
      '--no-open',
      '--trusted-host', 'nico.tailxxxx.ts.net',
    ])).toMatchObject({
      values: {
        host: '0.0.0.0',
        port: 0,
        openBrowser: false,
        trustedHosts: ['nico.tailxxxx.ts.net'],
      },
      exits: [],
    })
  })

  it('rejects whitespace accidentally pasted into a variadic trusted-host value', () => {
    const result = parse(['--trusted-host', 'nico.tailxxxx.ts.net\u3000--host'])
    expect(result.values).toBeUndefined()
    expect(result.exits).toEqual([1])
  })

  it('rejects unsupported bind literals instead of pretending WebServer accepts them', () => {
    const result = parse(['--host', '192.168.1.20'])
    expect(result.values).toBeUndefined()
    expect(result.exits).toEqual([1])
  })

  it('requires a second explicit opt-in for unauthenticated all-interface mode', () => {
    const rejected = parse(['--host', '0.0.0.0', '--browser-auth', 'disabled'])
    expect(rejected.values).toBeUndefined()
    expect(rejected.exits).toEqual([1])
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const accepted = parse([
      '--host', '0.0.0.0',
      '--browser-auth', 'disabled',
      '--allow-unauthenticated-remote',
    ])
    expect(accepted.values).toMatchObject({
      host: '0.0.0.0',
      browserAuth: 'disabled',
      allowUnauthenticatedRemote: true,
    })
    expect(accepted.exits).toEqual([])
    expect(warning).toHaveBeenCalled()
  })

  it('allows auth-off on loopback and warns visibly', () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = parse(['--browser-auth', 'disabled', '--no-open'])
    expect(result.values).toMatchObject({ browserAuth: 'disabled', openBrowser: false })
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('BrowserAuth is disabled'))
  })

  it('normalizes a root advertised URL and rejects a reverse-proxy path', () => {
    expect(normalizeAdvertisedUrl('https://Nico.tailxxxx.ts.net')).toBe('https://nico.tailxxxx.ts.net/')
    expect(() => normalizeAdvertisedUrl('https://example.test/dsh')).toThrow(/path prefixes/u)
  })

  it('rejects credentials, query, and non-http schemes', () => {
    for (const candidate of [
      'https://user:pass@example.test/',
      'https://example.test/?token=leak',
      'file:///tmp/dsh',
    ]) expect(() => normalizeAdvertisedUrl(candidate)).toThrow()
  })

  it('treats empty and null advertised values as unset', () => {
    expect(normalizeAdvertisedUrl(undefined)).toBeNull()
    expect(normalizeAdvertisedUrl(null)).toBeNull()
    expect(normalizeAdvertisedUrl('')).toBeNull()
  })
})
