/**
 * Android-friendly PWA surface for the DSH Web UI.
 *
 * The upstream frontend currently ships a manifest whose start_url is `/` and
 * only a small SVG favicon. `/` is intentionally protected by BrowserAuth, so
 * an installed Android shortcut can reopen into the auth failure page after a
 * process restart. This plugin adds a tiny unauthenticated bootstrap route:
 * it performs no application work, preserves the Connection Host/Origin fence,
 * and redirects through the official authenticatedUrl() seam. The redirect
 * therefore keeps working for both BrowserAuth= dsh and the explicit auth-off
 * adapter supplied by dsh-web-remote.
 *
 * The plugin also owns the manifest and icon paths. The opaque PNGs include a
 * background and real 192/512 dimensions, which avoids Android treating the
 * upstream 50px transparent/SVG-only favicon as an unusable white icon.
 */

import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-web-pwa'
export const inject = ['webServer', 'connection']

const MANIFEST_PATH = '/manifest.webmanifest'
const START_PATH = '/.dsh-pwa/start'
const ICON_192_PATH = '/.dsh-pwa/icon-192.png'
const ICON_512_PATH = '/.dsh-pwa/icon-512.png'
const FAVICON_PATH = '/favicon.svg'

const PWA_ICON_192 = readFileSync(new URL('../assets/icon-192.png', import.meta.url))
const PWA_ICON_512 = readFileSync(new URL('../assets/icon-512.png', import.meta.url))
const PWA_FAVICON = readFileSync(new URL('../assets/icon.svg', import.meta.url))

/** Optional canonical public origin used behind a reverse proxy. */
export interface Config {
  publicUrl: string | null
}

export const Config: z<Config> = z.object({
  publicUrl: z.union([z.string(), z.const(null)]).default(null),
})

/** Public paths are exported so tests and reverse-proxy documentation do not duplicate strings. */
export const paths = {
  manifest: MANIFEST_PATH,
  start: START_PATH,
  icon192: ICON_192_PATH,
  icon512: ICON_512_PATH,
  favicon: FAVICON_PATH,
} as const

/** Normalize one root-level HTTP(S) public URL. */
export function normalizePublicUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('publicUrl must be an absolute http:// or https:// URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('publicUrl must use http:// or https://')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('publicUrl must not contain userinfo')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('publicUrl must not contain a query or fragment')
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new TypeError('publicUrl must name the Web root; path prefixes are not supported')
  }
  parsed.pathname = '/'
  return parsed.href
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Resolve the externally visible origin for a PWA bootstrap request.
 * `publicUrl` wins; otherwise the reverse proxy's first X-Forwarded-Proto
 * value is used when it is a normal HTTP(S) scheme, followed by the Host
 * header. A proxy must overwrite, rather than append to, that header.
 */
export function requestOrigin(request: IncomingMessage, publicUrl: string | null): string {
  if (publicUrl !== null) return publicUrl
  const host = header(request, 'host')
  if (host === undefined || host === '') throw new TypeError('PWA bootstrap request has no Host header')
  const forwarded = header(request, 'x-forwarded-proto')
    ?.split(',', 1)[0]
    ?.trim()
    .toLowerCase()
  const protocol = forwarded === 'http' || forwarded === 'https'
    ? forwarded
    : (request.socket as { encrypted?: boolean }).encrypted === true ? 'https' : 'http'
  const origin = new URL(`${protocol}://${host}`)
  origin.pathname = '/'
  origin.search = ''
  origin.hash = ''
  return origin.href
}

function assetUrl(path: string, publicUrl: string | null): string {
  return publicUrl === null ? path : new URL(path, publicUrl).href
}

/** Build the manifest consumed by Chrome on Android. */
export function createManifest(publicUrl: string | null): string {
  return JSON.stringify({
    id: assetUrl('/', publicUrl),
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: assetUrl(START_PATH, publicUrl),
    scope: assetUrl('/', publicUrl),
    display: 'standalone',
    background_color: '#0b1020',
    theme_color: '#0b1020',
    description: 'DeepSeek Harness Web UI',
    icons: [
      {
        src: assetUrl(ICON_192_PATH, publicUrl),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: assetUrl(ICON_512_PATH, publicUrl),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }, null, 2) + '\n'
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | Uint8Array = '',
): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  response.writeHead(status, {
    ...headers,
    'content-length': String(bytes.byteLength),
  })
  response.end(request.method === 'HEAD' ? undefined : bytes)
}

function sendText(request: IncomingMessage, response: ServerResponse, status: number, body: string): void {
  send(request, response, status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  }, body)
}

/** Enforce the official Host/Origin fence while deliberately ignoring only its 401 auth result. */
function acceptsTrustedRequest(
  connection: HostConnectionHandle,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const rejection = connection.requestRejection(request)
  if (rejection !== 403) return true
  sendText(request, response, 403, 'forbidden\n')
  return false
}

function route(
  path: string,
  handler: WebRoute['handler'],
): WebRoute {
  return { kind: 'exact', path, handler }
}

function assertCapabilities(ctx: Context): void {
  const server = ctx.get('webServer') as { register?: unknown } | undefined
  const connection = ctx.get('connection') as Partial<HostConnectionHandle> | undefined
  if (typeof server?.register !== 'function') {
    throw new Error('dsh-web-pwa: incompatible DSH WebServer; expected register(route)')
  }
  if (typeof connection?.requestRejection !== 'function'
    || typeof connection.authenticatedUrl !== 'function') {
    throw new Error(
      'dsh-web-pwa: incompatible DSH Connection; expected requestRejection() and authenticatedUrl() seams',
    )
  }
}

/** Install the PWA manifest, Android icons, and auth-preserving start route. */
export function apply(ctx: Context, config: Config = { publicUrl: null }): void {
  assertCapabilities(ctx)
  const publicUrl = normalizePublicUrl(config.publicUrl)
  const manifest = Buffer.from(createManifest(publicUrl), 'utf8')
  const connection = ctx.connection

  const routes: WebRoute[] = [
    route(MANIFEST_PATH, (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(request, response, 405, 'method not allowed\n')
        return
      }
      if (!acceptsTrustedRequest(connection, request, response)) return
      send(request, response, 200, {
        'cache-control': 'no-cache',
        'content-type': 'application/manifest+json',
        'x-content-type-options': 'nosniff',
      }, manifest)
    }),
    route(ICON_192_PATH, (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(request, response, 405, 'method not allowed\n')
        return
      }
      if (!acceptsTrustedRequest(connection, request, response)) return
      send(request, response, 200, {
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
      }, PWA_ICON_192)
    }),
    route(ICON_512_PATH, (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(request, response, 405, 'method not allowed\n')
        return
      }
      if (!acceptsTrustedRequest(connection, request, response)) return
      send(request, response, 200, {
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
      }, PWA_ICON_512)
    }),
    route(FAVICON_PATH, (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(request, response, 405, 'method not allowed\n')
        return
      }
      if (!acceptsTrustedRequest(connection, request, response)) return
      send(request, response, 200, {
        'cache-control': 'public, max-age=31536000, immutable',
        'content-type': 'image/svg+xml',
        'x-content-type-options': 'nosniff',
      }, PWA_FAVICON)
    }),
    route(START_PATH, (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendText(request, response, 405, 'method not allowed\n')
        return
      }
      if (!acceptsTrustedRequest(connection, request, response)) return
      try {
        const target = connection.authenticatedUrl(requestOrigin(request, publicUrl))
        send(request, response, 303, {
          'cache-control': 'no-store',
          location: target,
          'referrer-policy': 'no-referrer',
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        sendText(request, response, 400, `dsh-web-pwa: cannot resolve bootstrap URL: ${reason}\n`)
      }
    }),
  ]

  ctx.effect(() => {
    const disposers = routes.map(item => ctx.webServer.register(item))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-web-pwa: manifest, icons, and bootstrap routes')
}

export default { name, inject, apply, Config }
