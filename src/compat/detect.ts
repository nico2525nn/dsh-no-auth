/**
 * Runtime capability checks for the small upstream seams this bundle uses.
 *
 * These checks intentionally mention capabilities instead of comparing a
 * package version. A DSH release can preserve the seam while changing its
 * version, and a backport can change a version without providing the method.
 */

import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

const CONNECTION_METHODS = [
  'requestRejection',
  'authorizeIndex',
  'authenticatedUrl',
  'createSharedFetchHandler',
] as const

/** Check the route-facing WebServer contract before mounting a replacement. */
export function assertWebServerCapabilities(value: unknown): asserts value is WebServer {
  const candidate = value as Partial<WebServer> | undefined
  const missing = [
    typeof candidate?.host === 'string' ? undefined : 'host',
    typeof candidate?.port === 'number' ? undefined : 'port',
    typeof candidate?.registerFallback === 'function' ? undefined : 'registerFallback',
    typeof candidate?.register === 'function' ? undefined : 'register',
    typeof candidate?.registerUpgrade === 'function' ? undefined : 'registerUpgrade',
    typeof candidate?.renderIndex === 'function' ? undefined : 'renderIndex',
  ].filter((entry): entry is string => entry !== undefined)
  if (missing.length !== 0) {
    throw new Error(
      'dsh-web-remote: incompatible DSH WebServer service; missing ' + missing.join(', ')
      + ' (expected the @deepseek-ai/dsh-host-webserver 0.1.5 Web contract)',
    )
  }
}

/** Check the public HostConnectionHandle seam before changing auth behavior. */
export function assertConnectionCapabilities(value: unknown): asserts value is HostConnectionHandle {
  const candidate = value as Partial<HostConnectionHandle> | undefined
  const missing = CONNECTION_METHODS.filter(method => typeof candidate?.[method] !== 'function')
  const details = [
    ...missing,
    typeof candidate?.rpc?.handle === 'function' ? undefined : 'rpc.handle',
    typeof candidate?.rpc?.intercept === 'function' ? undefined : 'rpc.intercept',
    typeof candidate?.fetch?.register === 'function' ? undefined : 'fetch.register',
  ].filter((entry): entry is string => entry !== undefined)
  if (details.length !== 0) {
    throw new Error(
      'dsh-web-remote: incompatible DSH Connection service; missing ' + details.join(', ')
      + ' (expected the public HostConnectionHandle seam from @deepseek-ai/dsh-client-connection)',
    )
  }
}

/** Stable name for diagnostics and the compatibility ledger. */
export const COMPATIBILITY_BASELINE = 'DSH 0.1.5-rc.1 / current 0.1.5-rc.2 master contract'
