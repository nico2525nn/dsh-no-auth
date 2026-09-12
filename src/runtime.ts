/**
 * Runtime glue for the independent Web bundle.
 *
 * This intentionally remains a small adapter around the maintained
 * frontend-static and webserver services. It owns only presentation (the
 * advertised URL), LAN trust sampling, optional remote-settings transport
 * metadata, and startup handoff.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { networkInterfaces } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { assertWebServerCapabilities } from './compat/detect.js'
import { normalizeAdvertisedUrl } from './startup.js'

export const name = 'web-runtime'
export const inject = ['webServer']
export const WEB_RUNTIME_SERVICE = 'webRuntime'

export interface WebRuntimeConfig {
  openBrowser: boolean
  printUrl: boolean
  surfaceContext: boolean
  trustedHosts: string[]
  advertiseUrl: string | null
  remoteSettings: boolean
}

export const Config: z<WebRuntimeConfig> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  advertiseUrl: z.union([z.string(), z.const(null)]).default(null),
  remoteSettings: z.boolean().default(false),
})

export interface WebRuntimeValues {
  lanAddresses: string[]
  trustedHosts: string[]
  advertiseUrl: string | null
}

const LOOPBACK_HOST = '127.0.0.1'
const ALL_INTERFACES_HOST = '0.0.0.0'
const DSH_WEB_URL = 'DSH_WEB_URL' as const
const ANNOUNCED_ROOTS = new WeakSet<Context>()

/** Derive the same LAN trust snapshot used for display and the API fence. */
export function resolveLanTrust(
  bindHost: string,
  extra: readonly string[],
  advertiseUrl: string | null = null,
): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> =>
        iface !== undefined && iface.family === 'IPv4' && !iface.internal,
      )
      .map(iface => iface.address)
    : []
  return {
    lanAddresses,
    trustedHosts: [...lanAddresses, ...extra],
    advertiseUrl,
  }
}

function localWebUrl(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('dsh-web-remote: webServer service missing while resolving Web URL')
  return 'http://' + LOOPBACK_HOST + ':' + String(port)
}

function publicWebUrl(ctx: Context, config: WebRuntimeConfig): string {
  return normalizeAdvertisedUrl(config.advertiseUrl) ?? localWebUrl(ctx)
}

function webSurfacePrompt(webUrl: string): string {
  return 'You are interacting with the user through the DeepSeek Harness Web GUI at ' + webUrl + '. '
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + 'pnpm run dev:web is also running from the same DSH checkout. Other Web artifacts require rebuilding and refreshing this URL. '
    + 'Starting another server does not update this GUI.'
}

const BROWSER_OPENER_MODULE = import.meta.resolve('open')
const BROWSER_OPENER_PROGRAM = [
  'try {',
  '  const { default: open } = await import(' + JSON.stringify(BROWSER_OPENER_MODULE) + ')',
  '  const launcher = await open(process.argv[1])',
  '  if (process.platform === "win32") {',
  '    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {',
  '      function onError(error) { launcher.off("close", onClose); reject(error) }',
  '      function onClose(code) { launcher.off("error", onError); resolve(code) }',
  '      launcher.ref(); launcher.once("error", onError); launcher.once("close", onClose)',
  '    })',
  '    if (code !== 0) throw new Error("browser operating-system launcher exited with code " + String(code))',
  '  }',
  '  process.exitCode = 0',
  '} catch (error) {',
  '  console.error(error)',
  '  process.exitCode = 1',
  '}',
].join('\\n')

function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module', '--eval', BROWSER_OPENER_PROGRAM, '--', url,
  ], { env: scrubbedParentEnv(), stdio: ['ignore', 'inherit', 'pipe'] })
}

async function openBrowser(url: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url)
  let stderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { stderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      launcher.off('close', onClose)
      reject(error)
    }
    const onClose = (code: number | null): void => {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = stderr.trim().split(/\r?\n/u)[0]
        reject(new Error(firstLine === undefined || firstLine === ''
          ? 'browser launcher exited with code ' + String(code)
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')))
        return
      }
      if (stderr !== '') process.stderr.write(stderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/** Test hooks; production uses these defaults. */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string) => Promise<void>
} = {
  resolveDistIndex: () => {
    const require = createRequire(import.meta.url)
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  },
  openBrowser,
}

/** Mount static UI, remote-settings metadata, surface context, and URL handoff. */
export function apply(ctx: Context, config: WebRuntimeConfig): void {
  if (ctx.get(WEB_RUNTIME_SERVICE, false) !== undefined) {
    throw new Error(
      'dsh-web-remote: another webRuntime provider is already active; '
      + 'the stock web-runtime row was not disabled by the bundle patch',
    )
  }
  assertWebServerCapabilities(ctx.get('webServer'))
  const normalizedAdvertiseUrl = normalizeAdvertisedUrl(config.advertiseUrl)
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts, normalizedAdvertiseUrl)
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(launchEnvironmentOf(ctx))

  ctx.provide(WEB_RUNTIME_SERVICE, runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })

  if (config.remoteSettings) {
    // Current DSH client/connection intentionally considers a served
    // non-loopback page remote. The only public input that changes that fact
    // is __DSH_TRANSPORT__.ownsHost, documented for worker-owned transports.
    // This explicit opt-in uses that existing seam; it does not alter the
    // server-side Host/Origin fence or BrowserAuth.
    ctx.on('webserver/index-inject', table => {
      table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
    })
  }

  if (config.surfaceContext) {
    ctx.inject(['systemPrompt'], promptCtx => {
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: promptCtx.systemPrompt.getSectionOrder('WEB_SURFACE'),
        text: () => webSurfacePrompt(publicWebUrl(promptCtx, config)),
      })
    })
    ctx.inject(['shellEnv'], shellCtx => {
      shellCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Canonical advertised URL of the DeepSeek Harness Web GUI.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: publicWebUrl(shellCtx, config) }),
      })
    })
  }

  if (config.printUrl || handoffBrowser) {
    ctx.inject(['connection'], connectionCtx => {
      const announceReady = (): void => {
        if (ANNOUNCED_ROOTS.has(connectionCtx.root)) return
        const webUrl = publicWebUrl(connectionCtx, config)
        const handoffUrl = connectionCtx.connection.authenticatedUrl(webUrl)
        const lanCandidate = config.advertiseUrl === null ? runtime.lanAddresses[0] : undefined
        const port = connectionCtx.webServer.port
        const lanUrl = lanCandidate === undefined
          ? undefined
          : connectionCtx.connection.authenticatedUrl(
            'http://' + lanCandidate + ':' + String(port),
          )
        ANNOUNCED_ROOTS.add(connectionCtx.root)
        if (config.printUrl) {
          const suffix = lanUrl === undefined ? '' : ' (LAN: ' + lanUrl + ')'
          console.log('dsh web: ' + handoffUrl + suffix)
        }
        if (handoffBrowser) {
          console.log('dsh web: opening the default browser; pass --no-open to disable')
          void internals.openBrowser(handoffUrl).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error)
            console.error(
              'dsh-web-remote: could not open the default browser because ' + reason
              + '; use the dsh web URL printed at startup',
            )
          })
        }
      }

      const loader = connectionCtx.get('loader')
      if (loader === undefined) announceReady()
      else void loader.await().then(() => {
        if (connectionCtx.get('webServer') !== undefined) announceReady()
      }).catch(() => {
        // A sibling boot failure owns the process result; do not print a URL
        // for a tree that is about to be disposed.
      })
    })
  }
}
