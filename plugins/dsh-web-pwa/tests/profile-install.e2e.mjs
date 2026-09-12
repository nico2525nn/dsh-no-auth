/**
 * Opt-in real profile test. It intentionally exercises the public command
 * boundary instead of importing the plugin directly: install, dump-config,
 * actual dsh web HTTP redirects/assets, and uninstall restoration.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const ENABLED = process.env.DSH_WEB_PWA_E2E === '1'
const COMMAND_TIMEOUT_MS = 120_000

function environment(dshHome) {
  return {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: join(dshHome, '.agents'),
    DSH_TELEMETRY_DISABLED: '1',
    NODE_NO_WARNINGS: '1',
    SSH_CONNECTION: '',
    SSH_TTY: '',
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = chunk => { output = `${output}${String(chunk)}`.slice(-120_000) }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} ${args.join(' ')} timed out:\n${output}`))
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited ${String(code)} ${String(signal)}:\n${output}`))
        return
      }
      resolve(output)
    })
  })
}

async function startWeb(dshHome) {
  const child = spawn('dsh', ['web', '--no-open', '--port', '0'], {
    cwd: REPO_ROOT,
    env: environment(dshHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const launchUrl = await new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const append = chunk => {
      output = `${output}${String(chunk)}`.slice(-120_000)
      const match = /dsh web: (http:\/\/[^\s]+)/u.exec(output)
      if (match?.[1] !== undefined) finish(resolve, match[1])
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    const timer = setTimeout(() => finish(reject, new Error(`dsh web did not become ready:\n${output}`)), COMMAND_TIMEOUT_MS)
    child.once('error', error => finish(reject, error))
    child.once('exit', (code, signal) => finish(reject, new Error(`dsh web exited ${String(code)} ${String(signal)}:\n${output}`)))
  })
  return { child, launchUrl, output: () => output }
}

async function stopWeb(server) {
  if (server.child.exitCode !== null) return
  const exited = new Promise(resolve => server.child.once('exit', resolve))
  server.child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`dsh web did not stop:\n${server.output()}`)), 15_000)),
  ])
}

test('clean profile install and PWA bootstrap route', { skip: !ENABLED, timeout: 300_000 }, async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-web-pwa-cli-'))
  let server
  try {
    const addOutput = await run('dsh', ['plugin', '--profile', 'web', 'add', PACKAGE_ROOT], { env: environment(dshHome) })
    assert.match(addOutput, /dsh-web-pwa/u)

    const dump = await run('dsh', ['--profile', 'web', '--dump-config'], { env: environment(dshHome) })
    assert.match(dump, /- id: dsh-web-pwa\n\s+name: dsh-web-pwa/u)
    assert.equal((dump.match(/name: dsh-web-pwa\b/gu) ?? []).length, 1)

    server = await startWeb(dshHome)
    const origin = new URL(server.launchUrl).origin
    const manifest = await fetch(`${origin}/manifest.webmanifest`)
    assert.equal(manifest.status, 200)
    const manifestBody = await manifest.json()
    assert.equal(manifestBody.start_url, '/.dsh-pwa/start')
    assert.deepEqual(manifestBody.icons.map(icon => icon.sizes), ['192x192', '512x512'])

    const start = await fetch(`${origin}/.dsh-pwa/start`, { redirect: 'manual' })
    assert.equal(start.status, 303)
    assert.match(start.headers.get('location') ?? '', /[?&]token=/u)

    const exchange = await fetch(start.headers.get('location'), { redirect: 'manual' })
    assert.equal(exchange.status, 303)
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';', 1)[0]
    assert.match(cookie, /^dsh-auth-/u)

    const root = await fetch(origin, { headers: { cookie } })
    assert.equal(root.status, 200)
    assert.match(await root.text(), /id="root"/u)
  } finally {
    if (server !== undefined) await stopWeb(server)
    const removeResult = await run('dsh', ['plugin', '--profile', 'web', 'remove', 'dsh-web-pwa'], {
      env: environment(dshHome),
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => undefined)
    void removeResult
    await rm(dshHome, { recursive: true, force: true })
  }
})
