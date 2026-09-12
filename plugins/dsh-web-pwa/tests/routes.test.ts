import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { apply, paths } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
})

interface ResponseResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    client.once('error', reject)
    client.end()
  })
}

function requestHost(headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>): string | undefined {
  if (headers instanceof Headers) return headers.get('host') ?? undefined
  const value = headers.host
  return typeof value === 'string' ? value : value?.[0]
}

function requestHeader(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : value?.[0]
}

function fakeConnection(mode: 'auth' | 'disabled'): HostConnectionHandle {
  return {
    rpc: { handle: () => async () => {}, intercept: () => async () => {} },
    fetch: { register: () => async () => {} },
    createSharedFetchHandler: () => ({
      requestBodyMode: () => 'buffered',
      fetch: async () => new Response('not found', { status: 404 }),
    }),
    requestRejection: request => {
      const host = requestHost(request.headers)
      if (host !== 'trusted.test' && host !== 'trusted.test:3080') return 403
      const origin = requestHeader(request.headers, 'origin')
      if (origin !== undefined && new URL(origin).host !== host) return 403
      return mode === 'auth' ? 401 : undefined
    },
    authorizeIndex: () => true,
    authenticatedUrl: baseUrl => {
      if (mode === 'disabled') return baseUrl
      const url = new URL(baseUrl)
      url.searchParams.set('token', 'fresh-test-token')
      return url.href
    },
  }
}

async function boot(mode: 'auth' | 'disabled', publicUrl?: string): Promise<Context> {
  const context = new Context()
  contexts.push(context)
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  context.provide('connection', fakeConnection(mode))
  apply(context, { publicUrl: publicUrl ?? null })
  return context
}

describe('real WebServer PWA routes', () => {
  it('bootstraps through the official auth URL while keeping public assets reachable', async () => {
    const context = await boot('auth')
    const port = context.webServer.port
    const manifest = await httpGet(port, paths.manifest, { host: 'trusted.test' })
    expect(manifest.status).toBe(200)
    expect(manifest.headers['content-type']).toBe('application/manifest+json')
    expect(JSON.parse(manifest.body.toString())).toMatchObject({ start_url: paths.start })

    const icon = await httpGet(port, paths.icon192, { host: 'trusted.test' })
    expect(icon.status).toBe(200)
    expect(icon.headers['content-type']).toBe('image/png')
    expect(icon.body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const start = await httpGet(port, paths.start, {
      host: 'trusted.test:3080',
      'x-forwarded-proto': 'https',
    })
    expect(start.status).toBe(303)
    expect(start.headers.location).toBe('https://trusted.test:3080/?token=fresh-test-token')
  })

  it('keeps auth-off bootstrap clean and rejects an untrusted Host', async () => {
    const context = await boot('disabled', 'https://nico.tailxxxx.ts.net/')
    const port = context.webServer.port
    const start = await httpGet(port, paths.start, { host: 'trusted.test' })
    expect(start.status).toBe(303)
    expect(start.headers.location).toBe('https://nico.tailxxxx.ts.net/')

    const rejected = await httpGet(port, paths.manifest, { host: 'evil.example' })
    expect(rejected.status).toBe(403)
    expect(rejected.body.toString()).toBe('forbidden\n')

    const crossSite = await httpGet(port, paths.manifest, {
      host: 'trusted.test',
      origin: 'https://evil.example',
    })
    expect(crossSite.status).toBe(403)
  })

  it('returns controlled method errors and supports HEAD without a body', async () => {
    const context = await boot('auth')
    const port = context.webServer.port
    expect((await httpGet(port, paths.manifest, { host: 'trusted.test' }, 'POST')).status).toBe(405)
    const head = await httpGet(port, paths.icon512, { host: 'trusted.test' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body.byteLength).toBe(0)
  })
})
