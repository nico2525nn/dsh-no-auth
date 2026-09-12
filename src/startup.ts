/**
 * Command-line/config provider for the remote Web bundle.
 *
 * The stock DSH provider intentionally rejects 0.0.0.0. The lower WebServer
 * schema already accepts it, so this provider is the only place where that
 * policy needs to be changed. Bind hosts are still limited to the exact
 * literals accepted by the current WebServer schema.
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const WEB_STARTUP_SERVICE = 'webStartup'

export type BindHost = '127.0.0.1' | '0.0.0.0'
export type BrowserAuthMode = 'dsh' | 'disabled'

/** Values consumed by the official webserver row and this bundle's rows. */
export interface WebStartupValues {
  openBrowser: boolean
  host?: BindHost
  port?: number
  trustedHosts: string[]
  browserAuth: BrowserAuthMode
  advertiseUrl: string | null
  remoteSettings: boolean
  allowUnauthenticatedRemote: boolean
}

/** Static profile configuration; command-line values take precedence. */
export type WebStartupConfig = Partial<WebStartupValues>

export const Config: z<WebStartupConfig> = z.object({
  openBrowser: z.boolean().default(true),
  host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(false),
  port: z.natural().max(65535).required(false),
  trustedHosts: z.array(String).default([]),
  browserAuth: z.union(['dsh', 'disabled'] as const).default('dsh'),
  advertiseUrl: z.union([z.string(), z.const(null)]).default(null),
  remoteSettings: z.boolean().default(false),
  allowUnauthenticatedRemote: z.boolean().default(false),
})

interface WebOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
  browserAuth?: string
  advertiseUrl?: string
  remoteSettings?: boolean
  allowUnauthenticatedRemote?: boolean
}

function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI with remote Web controls.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host: 127.0.0.1 or 0.0.0.0')
    .option('--no-open', 'do not open the Web UI in the default browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority accepted by the Host/Origin trust fence (repeatable)')
    .option('--browser-auth <mode>', 'browser auth mode: dsh (default) or disabled')
    .option('--advertise-url <url>', 'URL shown/opened to users; bind host and advertised authority are independent')
    .option('--remote-settings', 'explicitly treat the remote Web page as owning the Host for Settings persistence')
    .option('--allow-unauthenticated-remote', 'explicitly allow browserAuth=disabled with a 0.0.0.0 bind')
    .addHelpText('after',
      '\nExamples:\n'
      + '  dsh --profile web --host 0.0.0.0 --port 3080 --trusted-host 192.168.1.20\n'
      + '  dsh --profile web --host 0.0.0.0 --advertise-url https://nico.tailxxxx.ts.net --trusted-host nico.tailxxxx.ts.net\n'
      + '  dsh --profile web --browser-auth disabled --host 127.0.0.1\n')
}

/** Normalize and validate a root-level HTTP(S) URL used for presentation. */
export function normalizeAdvertisedUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('advertiseUrl must be an absolute http:// or https:// URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('advertiseUrl must use http:// or https://')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('advertiseUrl must not contain userinfo')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError('advertiseUrl must not contain a query or fragment')
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new TypeError('advertiseUrl must name the Web root; path prefixes are not supported')
  }
  parsed.pathname = '/'
  return parsed.href
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new TypeError('--port must be a number, got ' + JSON.stringify(value))
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new TypeError('--port must be between 0 and 65535, got ' + JSON.stringify(value))
  }
  return port
}

function parseHost(value: string): BindHost {
  if (value !== '127.0.0.1' && value !== '0.0.0.0') {
    throw new TypeError('--host must be 127.0.0.1 or 0.0.0.0, got ' + JSON.stringify(value))
  }
  return value
}

function parseBrowserAuth(value: string): BrowserAuthMode {
  if (value !== 'dsh' && value !== 'disabled') {
    throw new TypeError('--browser-auth must be "dsh" or "disabled", got ' + JSON.stringify(value))
  }
  return value
}

/**
 * Commander treats `--trusted-host` as a variadic option. A pasted full-width
 * space can therefore become part of the authority token and make the next
 * option (`--host`, `--port`, ...) silently disappear. Authorities cannot
 * contain whitespace, so fail at the command boundary with a useful remedy.
 */
function validateTrustedHosts(values: readonly string[]): string[] {
  for (const value of values) {
    if (/\s/u.test(value)) {
      throw new TypeError(
        '--trusted-host values must not contain whitespace; use ordinary ASCII spaces between options',
      )
    }
  }
  return [...values]
}

function usageError(program: Command, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  program.error('error: ' + message)
}

function warnForDangerousMode(values: WebStartupValues): void {
  if (values.browserAuth === 'disabled') {
    const remote = values.host === '0.0.0.0'
    const scope = remote ? 'network-reachable' : 'trusted-host-reachable'
    console.error(
      'dsh-web-remote WARNING: BrowserAuth is disabled; ' + scope
      + ' Web requests have no token or cookie gate. '
      + 'The Host/Origin trusted-host fence remains active, but Web UI/RPC actions are powerful.',
    )
  }
  if (values.remoteSettings) {
    console.error(
      'dsh-web-remote WARNING: remoteSettings is enabled; non-loopback pages will use Host-persistent Settings '
      + 'and may open a Settings document on the DSH host. Enable this only for a deployment you administer.',
    )
  }
}

/** Parse one dsh invocation and publish the values read by downstream rows. */
export function apply(ctx: Context, config?: WebStartupConfig): void {
  if (ctx.get(WEB_STARTUP_SERVICE, false) !== undefined) {
    throw new Error(
      'dsh-web-remote: another webStartup provider is already active; '
      + 'the stock web-startup row was not disabled by the bundle patch',
    )
  }
  const defaults: WebStartupValues = {
    openBrowser: config?.openBrowser ?? true,
    ...(config?.host === undefined ? {} : { host: config.host }),
    ...(config?.port === undefined ? {} : { port: config.port }),
    trustedHosts: [...(config?.trustedHosts ?? [])],
    browserAuth: config?.browserAuth ?? 'dsh',
    advertiseUrl: normalizeAdvertisedUrl(config?.advertiseUrl),
    remoteSettings: config?.remoteSettings ?? false,
    allowUnauthenticatedRemote: config?.allowUnauthenticatedRemote ?? false,
  }

  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    let host: BindHost | undefined
    let port: number | undefined
    let browserAuth: BrowserAuthMode
    let advertiseUrl: string | null
    try {
      host = options.host === undefined ? defaults.host : parseHost(options.host)
      port = options.port === undefined ? defaults.port : parsePort(options.port)
      browserAuth = options.browserAuth === undefined ? defaults.browserAuth : parseBrowserAuth(options.browserAuth)
      advertiseUrl = options.advertiseUrl === undefined
        ? defaults.advertiseUrl
        : normalizeAdvertisedUrl(options.advertiseUrl)
    } catch (error) {
      usageError(program, error)
    }

    let trustedHosts: string[]
    try {
      trustedHosts = validateTrustedHosts([
        ...defaults.trustedHosts,
        ...(options.trustedHost ?? []),
      ])
    } catch (error) {
      usageError(program, error)
    }

    const values: WebStartupValues = {
      openBrowser: options.open === undefined ? defaults.openBrowser : options.open,
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
      trustedHosts: trustedHosts!,
      browserAuth: browserAuth!,
      advertiseUrl: advertiseUrl!,
      remoteSettings: options.remoteSettings === true || defaults.remoteSettings,
      allowUnauthenticatedRemote: options.allowUnauthenticatedRemote === true || defaults.allowUnauthenticatedRemote,
    }
    if (values.host === '0.0.0.0' && values.browserAuth === 'disabled' && !values.allowUnauthenticatedRemote) {
      usageError(
        program,
        'browserAuth=disabled with --host 0.0.0.0 requires explicit --allow-unauthenticated-remote '
        + '(or allowUnauthenticatedRemote: true in the profile config)',
      )
    }
    warnForDangerousMode(values)
    ctx.provide(WEB_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
