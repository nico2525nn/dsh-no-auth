/*
 * Optional release smoke test against the real DSH CLI.
 *
 * It is deliberately separate from the fast unit suite because it resolves
 * the selected DSH channel and boots two complete Web profiles. Run it with:
 *
 *   DSH_WEB_REMOTE_E2E=1 node --test tests/cli-e2e.test.mjs
 *
 * Set DSH_WEB_REMOTE_DSH to an explicit release when reproducing a baseline,
 * for example @deepseek-ai/dsh@0.1.5-rc.1.
 *
 * The test installs this checkout through `dsh plugin add`, exercises the
 * actual HTTP and upgrade carriers, then removes the plugin and checks that
 * the stock rows are restored. The package itself remains independent of the
 * DSH core repository.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const enabled = process.env.DSH_WEB_REMOTE_E2E === '1'
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const dshPackage = process.env.DSH_WEB_REMOTE_DSH ?? '@deepseek-ai/dsh'
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

function dshEnvironment(home) {
  return { ...process.env, DSH_HOME: home }
}

function runDsh(home, args) {
  const result = spawnSync(
    npmCommand,
    ['exec', '--yes', '--package', dshPackage, '--', 'dsh', ...args],
    {
      cwd: repositoryRoot,
      env: dshEnvironment(home),
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  )
  const stdout = String(result.stdout ?? '')
  const stderr = String(result.stderr ?? '')
  const output = `${stdout}${stderr}`
  if (result.error !== undefined) throw result.error
  assert.equal(result.status, 0, `DSH command failed: ${args.join(' ')}\n${output}`)
  return stdout
}

function startDsh(home, args) {
  const child = spawn(
    npmCommand,
    ['exec', '--yes', '--package', dshPackage, '--', 'dsh', ...args],
    {
      cwd: repositoryRoot,
      env: dshEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  )
  let output = ''
  const append = chunk => { output += String(chunk) }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', append)
  child.stderr.on('data', append)

  const ready = new Promise((resolveReady, rejectReady) => {
    let timer
    const inspect = () => {
      const match = /^dsh web: (.+)$/mu.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolveReady(match[1])
        return
      }
      if (child.exitCode !== null) {
        clearTimeout(timer)
        rejectReady(new Error(`DSH Web process exited before readiness\n${output}`))
      }
    }
    timer = setTimeout(() => {
      rejectReady(new Error(`DSH Web process did not print a readiness URL\n${output}`))
      child.kill('SIGTERM')
    }, 90_000)
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.on('exit', inspect)
  })

  return { child, ready, output: () => output, processGroupId: child.pid }
}

function signalDsh(processHandle, signal) {
  const child = processHandle.child
  if (process.platform !== 'win32' && processHandle.processGroupId !== undefined) {
    try {
      process.kill(-processHandle.processGroupId, signal)
      return
    } catch {
      // The group may already be gone; the direct child fallback below is safe.
    }
  }
  if (child.exitCode === null) child.kill(signal)
}

async function stopDsh(processHandle) {
  const child = processHandle.child
  const closeStreams = () => {
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  signalDsh(processHandle, 'SIGTERM')
  if (child.exitCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise(resolveStop => setTimeout(resolveStop, 5_000)),
    ])
  }
  signalDsh(processHandle, 'SIGKILL')
  closeStreams()
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListening, rejectListening) => {
    server.once('error', rejectListening)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  const address = server.address()
  assert.notEqual(address, null)
  assert.equal(typeof address, 'object')
  const port = address.port
  await new Promise((resolveClosed, rejectClosed) => server.close(error => {
    if (error !== undefined) rejectClosed(error)
    else resolveClosed()
  }))
  return port
}

async function get(port, host, path, headers = {}) {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: host, ...headers },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const headerRecord = Object.fromEntries(
          Object.entries(response.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(', ') : (value ?? ''),
          ]),
        )
        resolveResponse({
          response: { status: response.statusCode ?? 0, headers: new Headers(headerRecord) },
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('error', rejectResponse)
    request.end()
  })
}

async function upgradeStatus(port, host, cookie) {
  return new Promise((resolveStatus, rejectStatus) => {
    const socket = connect(port, '127.0.0.1')
    let settled = false
    let data = ''
    const finish = (error, status) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) rejectStatus(error)
      else resolveStatus(status)
    }
    socket.setTimeout(5_000, () => finish(new Error('WebSocket upgrade timed out')))
    socket.on('error', error => finish(error))
    socket.on('data', chunk => {
      data += String(chunk)
      const match = /^HTTP\/1\.1\s+(\d+)/mu.exec(data)
      if (match !== null) finish(undefined, Number(match[1]))
    })
    socket.once('connect', () => {
      socket.write([
        'GET /api/remote.mux HTTP/1.1',
        `Host: ${host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
        '',
        '',
      ].join('\r\n'))
    })
  })
}

if (!enabled) {
  test('real DSH CLI smoke test (opt in with DSH_WEB_REMOTE_E2E=1)', {
    skip: 'set DSH_WEB_REMOTE_E2E=1 to run the release smoke test',
  }, () => {})
} else {
  test('installs, boots, secures, and removes the real DSH Web profile', { timeout: 180_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-remote-e2e-'))
    const processes = []
    try {
      runDsh(home, ['plugin', '--profile', 'web', 'add', repositoryRoot])
      const installed = runDsh(home, ['--profile', 'web', '--dump-config'])
      assert.match(installed, /name: dsh-web-remote\/startup/u)
      assert.match(installed, /name: dsh-web-remote\/runtime/u)
      assert.match(installed, /name: dsh-web-remote\/connection/u)
      assert.match(installed, /id: web-startup[\s\S]*?disabled: true/u)
      assert.match(installed, /id: web-runtime[\s\S]*?disabled: true/u)
      const connectionRow = /(?:^|\n)- id: connection\n[\s\S]*?(?=\n(?:#|- id:)|$)/u.exec(installed)?.[0]
      assert.ok(connectionRow)
      assert.match(connectionRow, /name: '@deepseek-ai\/dsh-client-connection'/u)
      assert.doesNotMatch(connectionRow, /disabled:/u)

      const unauthenticatedPort = await freePort()
      const unauthenticatedHost = `nico.example.test:${String(unauthenticatedPort)}`
      const unauthenticated = startDsh(home, [
        'web', '--no-open', '--host', '0.0.0.0', '--port', String(unauthenticatedPort),
        '--advertise-url', `http://${unauthenticatedHost}`,
        '--trusted-host', unauthenticatedHost,
        '--browser-auth', 'disabled', '--allow-unauthenticated-remote', '--remote-settings',
      ])
      processes.push(unauthenticated)
      const advertisedUnauthenticated = await unauthenticated.ready
      assert.equal(advertisedUnauthenticated, `http://${unauthenticatedHost}/`)
      assert.doesNotMatch(advertisedUnauthenticated, /token=/u)
      const unauthenticatedRoot = await get(unauthenticatedPort, unauthenticatedHost, '/')
      assert.equal(unauthenticatedRoot.response.status, 200)
      assert.match(unauthenticatedRoot.body, /__DSH_TRANSPORT__/u)
      // The official connection row is dual-face: its browser half must stay
      // in the boot manifest or the page reports every dependent UI plugin as
      // pending even though the host HTTP server itself is healthy.
      assert.match(unauthenticatedRoot.body, /@deepseek-ai\/dsh-client-connection\/client\.js/u)
      assert.match(unauthenticated.output(), /remoteSettings is enabled/u)
      assert.equal((await get(unauthenticatedPort, 'untrusted.example', '/')).response.status, 403)
      assert.equal((await get(
        unauthenticatedPort,
        'untrusted.example',
        '/api/no-such-route',
      )).response.status, 403)
      assert.equal((await get(
        unauthenticatedPort,
        unauthenticatedHost,
        '/',
        { Origin: 'https://evil.example' },
      )).response.status, 403)
      assert.equal((await get(
        unauthenticatedPort,
        unauthenticatedHost,
        '/api/no-such-route',
      )).response.status, 404)
      assert.equal(await upgradeStatus(unauthenticatedPort, 'untrusted.example'), 403)
      assert.equal(await upgradeStatus(unauthenticatedPort, unauthenticatedHost), 101)
      await stopDsh(unauthenticated)

      const authenticated = startDsh(home, [
        'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
      ])
      processes.push(authenticated)
      const launchUrl = await authenticated.ready
      const launch = new URL(launchUrl)
      const authenticatedPort = Number(launch.port)
      const authenticatedHost = launch.host
      assert.ok(authenticatedPort > 0)
      assert.equal(launch.searchParams.has('token'), true)
      assert.equal((await get(authenticatedPort, authenticatedHost, '/')).response.status, 401)
      const exchanged = await get(
        authenticatedPort,
        authenticatedHost,
        launch.pathname + launch.search,
      )
      assert.equal(exchanged.response.status, 303)
      const cookieHeader = exchanged.response.headers.get('set-cookie')
      assert.ok(cookieHeader)
      const cookie = cookieHeader.split(';', 1)[0]
      assert.equal((await get(authenticatedPort, authenticatedHost, '/', { Cookie: cookie })).response.status, 200)
      assert.equal((await get(authenticatedPort, authenticatedHost, '/api/no-such-route')).response.status, 401)
      assert.equal((await get(
        authenticatedPort,
        authenticatedHost,
        '/api/no-such-route',
        { Cookie: cookie },
      )).response.status, 404)
      assert.equal(await upgradeStatus(authenticatedPort, authenticatedHost), 401)
      await stopDsh(authenticated)

      runDsh(home, ['plugin', '--profile', 'web', 'remove', 'dsh-web-remote'])
      const restored = runDsh(home, ['--profile', 'web', '--dump-config'])
      assert.doesNotMatch(restored, /dsh-web-remote/u)
      assert.match(restored, /name: '@deepseek-ai\/dsh-web-app\/startup'/u)
      const restoredStartup = /- id: web-startup[\s\S]*?(?=\n- id:|\n# ==|$)/u.exec(restored)?.[0]
      assert.ok(restoredStartup)
      assert.doesNotMatch(restoredStartup, /disabled:/u)
    } finally {
      for (const processHandle of processes) await stopDsh(processHandle)
      await rm(home, { recursive: true, force: true })
    }
  })
}
