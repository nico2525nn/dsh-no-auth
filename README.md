# dsh-web-remote

dsh-web-remote is an independent DeepSeek Harness bundle for deployments where the Web UI is reached through a LAN address, Tailscale, SSH forwarding, or a reverse proxy. It is installed through DSH's normal profile plugin flow and does not modify or fork the Harness source tree.

The package targets the Web contracts present in DSH 0.1.5-rc.1 and the current upstream master examined at commit c291e7961a515f6d7af9304e7fd1d257929aef26 (0.1.5-rc.2). The source of truth is the upstream implementation, not the older community dsh-web-startup-auth design.

## Install

From this checkout:

~~~sh
dsh plugin --profile web add .
dsh --profile web --dump-config
~~~

The DSH plugin manager sees the dsh.bundle.patch declaration in this package and appends the package to dsh.profile.bundles. DSH patch semantics use the name field as an expected-name guard, not a rename operation, so the bundle disables the two host-side Web rows that need replacement and inserts small adapter rows. The official `connection` row remains active because it is a dual-face host/client package: its host service is adapted after activation, while its browser-side `dsh.client` entry stays in `window.__DSH_BOOT__`. The official webserver, frontend-static, and browser roster remain upstream-owned. Removing the package with dsh plugin --profile web remove dsh-web-remote removes its bundle layer. The shipped @deepseek-ai/dsh-web-app layer then becomes active again on the next launch.

For a published package, use dsh plugin --profile web add dsh-web-remote instead. Run npm run build first when installing a checkout that has not yet been prepared.

### If DSH fails before the Web server starts

An error such as `The requested module '@deepseek-ai/dsh-attachment' does not provide an export named ...`, or the equivalent error for `dsh-session-persistence` or `dsh-session-query`, is a DSH installation problem that occurs before `dsh-web-remote/startup` is loaded. It means that the DSH CLI and its peer packages are from different release lines, such as a newer CLI with those peers still at an older `0.1.0-rc.6` generation. Changing `--host`, BrowserAuth, or the profile patch cannot affect this failure.

Check the CLI first:

~~~sh
dsh --version
dsh plugin --profile web list
~~~

Also check which launcher is being executed. `pnpm dsh` and `dsh` can be different global shims, with different release channels and dependency trees:

~~~sh
type -a dsh
dsh --version
pnpm dsh --version
~~~

Use one coherent DSH installation for the profile. With a pnpm global install, an isolated linker can also leave the profile fallback resolving an older package from `~/node_modules`; the telltale errors are a credentials schema mismatch or an experimental package importing an unexported DSH subpath. Rebuild the pnpm global installation with its selected channel and a hoisted linker, or invoke the other coherent DSH installation directly. Do not mix Bun and pnpm DSH globals or add arbitrary core packages to the plugin as a workaround.

Do not try to repair this by adding arbitrary DSH peer packages to the plugin or by copying a release-specific version into the plugin configuration. The DSH distribution/package manager must resolve its own CLI and peer set as one compatible release line. If the global installation is polluted by packages from another DSH generation, use a clean DSH installation or an isolated npm invocation while preserving the profile:

~~~sh
DSH_HOME="$HOME/.dsh" npm exec --yes \
  --package @deepseek-ai/dsh -- \
  dsh web --no-open
~~~

The plugin itself declares semver-compatible DSH ranges and performs capability checks; it does not select the host DSH release. A lockfile may record concrete transitive versions, but those are installation artifacts rather than a runtime version policy.

After the CLI passes this loader stage, the plugin's own startup errors identify the affected capability or configuration. The repository's real CLI E2E test also exercises this boundary with a clean `DSH_HOME`.

## Modes

The safe default remains DSH's token-to-cookie BrowserAuth and a loopback bind:

~~~sh
dsh web --no-open
~~~

Remote bind with the existing trust fence and an explicitly advertised URL:

~~~sh
dsh web \
  --host 0.0.0.0 \
  --port 3080 \
  --advertise-url https://nico.tailxxxx.ts.net \
  --trusted-host nico.tailxxxx.ts.net \
  --no-open
~~~

advertise-url is presentation-only: it controls the startup URL, browser handoff, DSH_WEB_URL, and the Web-surface context. It does not silently add a Host authority to the trust fence. Add the reverse-proxy/Tailscale/LAN authority with one or more trusted-host values. Root-level http:// and https:// URLs are supported; path prefixes are rejected because the current static frontend is rooted at /.

Use ordinary ASCII spaces between options when copying the command. `--trusted-host` is variadic; a full-width Japanese space (`　`) before the next option becomes part of the trusted-host value and is rejected with an explicit error instead of silently dropping `--host` or `--port`.

host is still limited to 127.0.0.1 and 0.0.0.0, because those are the only bind values accepted by the current dsh-host-webserver schema. port 0 is passed through unchanged and the URL line uses the OS-assigned listening port.

BrowserAuth can be disabled only by an explicit choice:

~~~sh
dsh web --browser-auth disabled --host 127.0.0.1
~~~

In this mode the launch token, session cookie, root index gate, API/RPC 401 gate, and WebSocket 401 gate are disabled. The official Host/Origin/trusted-host fence remains in force; an untrusted Host or cross-site Origin still receives 403. The implementation keeps the official connection plugin and replaces only its public `requestRejection`, `authorizeIndex`, and `authenticatedUrl` methods after the service is active. BrowserAuth's private signing implementation, the browser transport, and the HTTP bridge are not copied.

Because an unauthenticated all-interface Web server exposes DSH's powerful RPC surface, this combination requires a second explicit flag:

~~~sh
dsh web \
  --host 0.0.0.0 \
  --browser-auth disabled \
  --allow-unauthenticated-remote \
  --trusted-host 192.168.1.20 \
  --no-open
~~~

Startup prints a prominent warning whenever BrowserAuth is disabled, and the all-interface combination is rejected without allow-unauthenticated-remote (or the equivalent profile config). Treat this as an administrator-only lab/deployment mode, not an Internet-facing setup.

## Profile configuration

CLI flags are suitable for per-invocation changes. For a persistent profile setting, add a row override to the profile's own cordis.patch.yml after installing the bundle:

~~~yaml
- id: dsh-web-remote-startup
  name: dsh-web-remote/startup
  config:
    host: 0.0.0.0
    port: 3080
    browserAuth: dsh
    advertiseUrl: https://nico.tailxxxx.ts.net
    trustedHosts:
      - nico.tailxxxx.ts.net
    remoteSettings: false
    allowUnauthenticatedRemote: false
~~~

The normal DSH patch replacement rule still applies. This row changes only the startup provider's configuration; the official webserver row continues to consume ctx.webStartup.host and ctx.webStartup.port, the custom runtime row consumes the same service, and the connection adapter consumes the official `connection` service plus the startup auth mode.

This is an optional configuration override, not another registration: do not copy the package's `insert` block into the profile or register a second provider. The package manifest remains the only installation-time loader entry.

remoteSettings is independent from BrowserAuth. It defaults to false, so a non-loopback page uses DSH's current client behavior: Settings scope is memory-backed/unavailable for durable Host settings. Setting it to true injects the existing __DSH_TRANSPORT__.ownsHost global before client boot, which makes the current client treat this explicit deployment as Host-owned. This enables Settings persistence and the native Settings document path; use it only when the remote browser and the DSH host are under the same administrative control. It does not disable or weaken BrowserAuth or the server trust fence.

## Design boundaries

The bundle intentionally does not replace dsh-host-webserver, dsh-host-frontend-static, or the frontend client. It relies on these upstream contracts:

- web-startup publishes openBrowser, optional host/port, and trusted authorities.
- dsh-host-webserver owns the actual listen(host, port) call, supports only 127.0.0.1/0.0.0.0, and reports the bound port for port: 0.
- dsh-client-connection remains the owner of the Host/Origin fence, API/RPC bridge, upgrade routes, and browser-side Connection module. Its HostConnectionHandle methods are the auth seam used by the adapter.
- dsh-host-frontend-static gates root index serving through connection.authorizeIndex while leaving ordinary assets public.
- dsh-web-frontend supplies the dist index path.
- the browser client computes isLoopback from the page hostname unless the documented __DSH_TRANSPORT__.ownsHost hook is true.

The adapter checks these capabilities at startup and fails loudly if a future DSH removes one. Version-specific imports are isolated under src/compat/; see docs/upstream-contracts.md.

## Tests and build

~~~sh
npm install
npm test
npm run typecheck
npm run build
npm run pack:check
# Optional: exercise the real HTTP/upgrade surfaces and install/remove flow
# against the current published channel.
DSH_WEB_REMOTE_E2E=1 npm run test:e2e

# Requested RC1 compatibility baseline:
DSH_WEB_REMOTE_E2E=1 \
DSH_WEB_REMOTE_DSH=@deepseek-ai/dsh@0.1.5-rc.1 \
npm run test:e2e
~~~

The fast tests cover startup URL validation, stock/disabled auth method behavior, 403 trust-fence preservation, the 0.0.0.0 policy, arbitrary ports including zero at the parser boundary, advertised URL/trust separation, remote-settings opt-in metadata, and actual bundle patch composition semantics. The optional CLI E2E test installs this checkout with `dsh plugin --profile web add`, then verifies the installed browser roster retains `@deepseek-ai/dsh-client-connection`, token-to-cookie auth, auth-off root/API/WebSocket access, Host/Origin rejection, advertised URL output, and uninstall restoration against the selected DSH channel. The underlying HTTP bridge, WebServer, and browser Connection module remain upstream-owned; the adapter never forks those route owners.

## Android PWA companion

The Android-specific manifest/icon/bootstrap fix is maintained as a separate
bundle in [`plugins/dsh-web-pwa/`](plugins/dsh-web-pwa/). It can be installed
alongside this remote bundle and does not replace the official Web rows. Build
that package, then run `dsh plugin --profile web add ./plugins/dsh-web-pwa`; its
README documents the clean-profile and Android startup flow.
