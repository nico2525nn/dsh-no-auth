import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { apply, internals, resolveLanTrust } from '../src/runtime.js'

interface ShellContribution {
  name: string
  variables: Record<string, { description: string }>
  resolve: () => Record<string, string>
}

function fakeWebServer(): object {
  return {
    host: '0.0.0.0',
    port: 4567,
    register: () => () => {},
    registerFallback: () => () => {},
    registerUpgrade: () => () => {},
    renderIndex: (html: string) => html,
  }
}

function fakeConnection(): object {
  return {
    rpc: { handle: () => {}, intercept: () => {} },
    fetch: { register: () => {} },
    createSharedFetchHandler: () => ({ requestBodyMode: () => 'buffered', fetch: async () => new Response() }),
    authorizeIndex: () => true,
    requestRejection: () => undefined,
    authenticatedUrl: (baseUrl: string) => {
      const url = new URL(baseUrl)
      url.pathname = '/'
      url.searchParams.set('token', 'test-token')
      return url.href
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  internals.resolveDistIndex = originalResolveDist
  internals.openBrowser = originalOpenBrowser
})

const originalResolveDist = internals.resolveDistIndex
const originalOpenBrowser = internals.openBrowser

describe('runtime URL/trust separation', () => {
  it('keeps an explicitly advertised authority separate from derived LAN trust', () => {
    const result = resolveLanTrust('0.0.0.0', ['nico.tailxxxx.ts.net'], 'https://nico.tailxxxx.ts.net/')
    expect(result.trustedHosts).toContain('nico.tailxxxx.ts.net')
    expect(result.advertiseUrl).toBe('https://nico.tailxxxx.ts.net/')
  })

  it('does not invent LAN trust for loopback', () => {
    expect(resolveLanTrust('127.0.0.1', [], null)).toEqual({
      lanAddresses: [],
      trustedHosts: [],
      advertiseUrl: null,
    })
  })

  it('publishes the advertised URL consistently to handoff, prompt, shell, and index transport metadata', async () => {
    internals.resolveDistIndex = () => '/tmp/dsh-web-remote-test-index.html'
    const ctx = new Context()
    ctx.provide('webServer', fakeWebServer() as never)
    ctx.provide('connection', fakeConnection() as never)
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
      { source: 'process', values: {} },
    ]))
    const contributions: ShellContribution[] = []
    ctx.provide('shellEnv', {
      register: (contribution: ShellContribution) => {
        contributions.push(contribution)
        return () => {}
      },
    } as never)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    internals.openBrowser = vi.fn(async () => {})

    apply(ctx, {
      openBrowser: true,
      printUrl: true,
      surfaceContext: true,
      trustedHosts: ['nico.tailxxxx.ts.net'],
      advertiseUrl: 'https://nico.tailxxxx.ts.net/',
      remoteSettings: true,
    })
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(log).toHaveBeenCalledWith(
      'dsh web: https://nico.tailxxxx.ts.net/?token=test-token',
    )
    expect(internals.openBrowser).toHaveBeenCalledWith(
      'https://nico.tailxxxx.ts.net/?token=test-token',
    )
    expect(contributions.find(entry => entry.name === 'web-runtime')?.resolve()).toEqual({
      DSH_WEB_URL: 'https://nico.tailxxxx.ts.net/',
    })
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.find(entry => entry.name === 'app:web-surface')?.text)
      .toContain('https://nico.tailxxxx.ts.net/')
    const injections: IndexInjection[] = []
    ctx.emit('webserver/index-inject', injections)
    expect(injections).toContainEqual({
      kind: 'global',
      name: '__DSH_TRANSPORT__',
      value: { ownsHost: true },
    })
    await ctx.fiber.dispose()
  })
})
