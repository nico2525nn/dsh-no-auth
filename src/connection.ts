/**
 * Connection adapter that preserves the official DSH HTTP/RPC/WebSocket
 * implementation and optionally removes only its 401 browser-auth decision.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ConnectionConfig,
  HostConnectionHandle,
  ConnectionTrustRequest,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRequestRejection,
} from '@deepseek-ai/dsh-client-connection'
import { assertConnectionCapabilities } from './compat/detect.js'

export type { ConnectionConfig }
export const inject = ['connection', 'webStartup']

export interface ConnectionPluginConfig {
  browserAuth: 'dsh' | 'disabled'
}

/** This row is an adapter only; the official connection row owns its schema. */
export const Config: z<ConnectionPluginConfig> = z.object({
  browserAuth: z.union(['dsh', 'disabled'] as const).default('dsh'),
})

/** Remove query/fragment data and the stock process token from a URL. */
export function cleanApplicationUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.href
}

/**
 * Patch only the auth-facing public methods on the official service.
 *
 * requestRejection still calls the official Host/Origin fence and converts
 * only its 401 result to allow. A 403 remains a 403. authorizeIndex is the
 * sole index gate used by frontend-static, and authenticatedUrl is used by
 * the startup handoff; changing all three keeps root/API/RPC/WebSocket and
 * the displayed URL consistent without copying BrowserAuth or the bridge.
 *
 * @returns a disposer that restores the official methods.
 */
export function disableBrowserAuth(connection: HostConnectionHandle): () => void {
  assertConnectionCapabilities(connection)
  const mutable = connection as HostConnectionHandle & {
    requestRejection: HostConnectionHandle['requestRejection']
    authorizeIndex: HostConnectionHandle['authorizeIndex']
    authenticatedUrl: HostConnectionHandle['authenticatedUrl']
  }
  const originalRequestRejection = mutable.requestRejection
  const originalAuthorizeIndex = mutable.authorizeIndex
  const originalAuthenticatedUrl = mutable.authenticatedUrl

  mutable.requestRejection = (request: ConnectionTrustRequest): ConnectionRequestRejection => {
    const result = originalRequestRejection.call(connection, request)
    return result === 401 ? undefined : result
  }
  mutable.authorizeIndex = (request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean => {
    // frontend-static calls authorizeIndex directly for / and index.html; it
    // does not call requestRejection first. Preserve the official Host/Origin
    // fence for those requests as well, while intentionally ignoring only the
    // official 401 auth result.
    if (originalRequestRejection.call(connection, request) === 403) {
      response.writeHead(403)
      response.end('forbidden')
      return false
    }
    return true
  }
  mutable.authenticatedUrl = (baseUrl: string): string => cleanApplicationUrl(baseUrl)

  return () => {
    mutable.requestRejection = originalRequestRejection
    mutable.authorizeIndex = originalAuthorizeIndex
    mutable.authenticatedUrl = originalAuthenticatedUrl
  }
}

/** Adapt the already-active official connection without replacing its row. */
export function apply(ctx: Context, config: ConnectionPluginConfig): void {
  const browserAuth = config?.browserAuth ?? 'dsh'
  const connection = ctx.get('connection')
  assertConnectionCapabilities(connection)
  if (browserAuth !== 'disabled') return

  const restore = disableBrowserAuth(connection)
  ctx.effect(() => restore, 'dsh-web-remote: restore official BrowserAuth adapter')
}
