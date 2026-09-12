# Upstream contracts and compatibility ledger

This document records the DSH source inspected before implementing dsh-web-remote. It is intentionally specific: when an upstream update changes one of these rows, the adapter should fail at boot or this document should be updated with a new compatibility module.

## Baseline inspected

- Repository: https://github.com/deepseek-ai/deepseek-harness
- Master commit inspected: c291e7961a515f6d7af9304e7fd1d257929aef26
- Master commit date: 2026-09-10 (source fetched and checked on 2026-09-12)
- Master package version: 0.1.5-rc.2
- npm baseline requested by the deployment: 0.1.5-rc.1
- The fetched repository exposed `master` as the current upstream branch; no separate `next` branch was available to compare. The compatibility boundary is therefore recorded against that master commit and the RC1 npm artifacts.
- Main source paths are under packages/; npm builds expose the corresponding lib/ entry points.

The current master and the npm 0.1.5-rc.1 Web package have the same relevant architecture: the startup rejection of 0.0.0.0 is in the Web startup provider, while the WebServer schema itself accepts 127.0.0.1 and 0.0.0.0. The current master adds surrounding documentation and source, but the public seams used here remain present.

The source read-through covered these ownership boundaries before implementation:

- `packages/bundle/web-app/src/startup.ts` owns the stock Commander options and the intentional `0.0.0.0` rejection; `packages/bundle/web-app/src/index.ts` owns URL presentation, browser handoff, `DSH_WEB_URL`, and the Web-surface context.
- `packages/bundle/web-app/cordis.patch.yml` shows that `webserver`, `web-runtime`, and `connection` receive values through lazy `ctx.webStartup`/`ctx.webRuntime` expressions. The bundle patch loader and `apps/cli/src/plugin.ts` were inspected for package-manifest registration and row replacement semantics.
- `packages/host/webserver/src/index.ts` owns the actual Node listener. Its schema is the authoritative two-value host union and its `port` getter reports the OS-assigned port after `port: 0` binding.
- `packages/client/connection/src/browser-auth.ts` owns the launch token, authority-bound cookie, and index exchange. `packages/client/connection/src/rpc-host.ts` and `src/index.ts` expose the request/auth seam and install the maintained API bridge. `src/api-request-trust.ts` is the separate Host/Origin/DNS-rebinding fence.
- `packages/client/connection/src/client/index.ts`, `packages/client/ui-settings/src/client/index.ts`, and `packages/client/ui-settings-general/src/client/index.ts` were inspected for `isLoopback`, `ownsHost`, persistence selection, and native Settings document behavior. The upstream Web tests and README/docs were used as contract evidence; the optional CLI E2E in this package exercises the installed composition.

## Contract ledger

| DSH row/service | Current owner | What this bundle relies on | Override / risk |
| --- | --- | --- | --- |
| web-startup / webStartup | packages/bundle/web-app/src/startup.ts | openBrowser, optional host, optional port, and trustedHosts are consumed through lazy config expressions. | Official row is disabled by expected-name guard and a small provider row is inserted to add browserAuth, advertiseUrl, remoteSettings, and the 0.0.0.0 policy. |
| webserver / webServer | packages/host/webserver/src/index.ts | host is exactly 127.0.0.1 or 0.0.0.0; port is 0..65535; configured 0 is passed to Node and port reports the assigned port. | Not replaced. Existing official row receives our webStartup service. |
| connection / connection | packages/client/connection/src/index.ts and src/rpc-host.ts | requestRejection, authorizeIndex, authenticatedUrl, the `rpc` registry, the `fetch` registry, and createSharedFetchHandler are the public HostConnectionHandle surface. Official route owners call them for /api, RPC channels, upgrades, and index serving. The row is dual-face: its `dsh.client` metadata also supplies the browser Connection module. | Official row stays active so the browser module remains in the manifest. A later adapter row injects the ready official service and only patches the three auth-facing methods in disabled mode. Private BrowserAuth, browser transport, bridge, route tables, and WebSocket code are not copied. |
| frontend-static | packages/host/frontend-static/src/index.ts | Root/index requests call ctx.connection.authorizeIndex; assets are otherwise handled by the maintained static server. | Not replaced. Its existing row is mounted by our runtime. |
| web-runtime / webRuntime | packages/bundle/web-app/src/index.ts | lanAddresses/trustedHosts are available before connection config and the runtime publishes URL/shell/prompt context. | Official row is disabled and a small runtime row is inserted because upstream has no advertised-URL extension point. Static fallback and server remain official. |
| client isLoopback / ownsHost | packages/client/connection/src/client/index.ts | isLoopback is true for loopback hostnames, non-browser contexts, or __DSH_TRANSPORT__.ownsHost === true. | remoteSettings true adds the documented global transport hook to the served index. Default remains false. |
| UI Settings persistence | packages/client/ui-settings/src/client/index.ts and ui-settings-general/src/client/index.ts | Non-loopback pages select memory persistence and do not create the native Settings document controller. | No client fork. remoteSettings opt-in changes the existing transport ownership fact; native document operations still run on the DSH host. |
| profile loader | apps/cli/src/plugin.ts and packages/boot/app-boot/src/profile.ts | A package manifest with dsh.bundle.patch is appended to dsh.profile.bundles by dsh plugin add; external layers apply after shipped bundles. | No loader patch. The package manifest is the only registration mechanism. |
| patch semantics | vendor/include/src/index.ts and docs/architecture.md | A row-targeted patch replaces overridden fields/config at row level; it is not a deep merge. The `name` field is an expected-name guard, not a row rename. | The patch disables the two host-side official provider rows with expected-name guards, then inserts startup/runtime adapters. The official dual-face connection row remains active and receives one later adapter; there is no duplicate connection provider or duplicate browser module. |

## Why BrowserAuth is adapted after official apply

In the inspected source, there is no public configuration field that disables BrowserAuth. BrowserAuth is exported as a class, but its process token, credential record, cookie signature, authority binding, and response behavior are internal implementation details. Copying that class or forking the entire Connection plugin would duplicate the highest-risk code and require keeping every API/RPC/upgrade route in sync. The connection row is also a dual-face row, so replacing it would accidentally remove the maintained browser Connection module from the client manifest.

The stable public seam is the HostConnectionHandle implemented by HostConnectionService. The official route owners call its methods dynamically. After official apply completes, the adapter turns only 401 into allow, makes index authorization return true, and makes authenticatedUrl return a clean root URL. A 403 from isTrustedApiRequest is preserved. If the auth methods, the RPC/Fetch registries, or the webserver route/index surface disappear, the runtime capability check raises an explicit incompatibility error.

The official plugin still initializes its credential-backed BrowserAuth object before the adapter replaces the method calls. This does not make a token or cookie required in disabled mode, but it means the plugin intentionally retains the official initialization path for compatibility. Keeping the official row also preserves its browser-side module metadata and all host route registration. Removing that initialization would require constructing HostConnectionService and reproducing more of the official plugin's setup, which is a larger and less stable override.

## Remote Settings finding

The current client does not have a host-side remoteSettings flag. The relevant behavior is client-side connection.isLoopback, which feeds UI Settings persistence and the native document controller. The current client explicitly documents __DSH_TRANSPORT__.ownsHost for a page whose transport owner controls the Host, so the bundle uses it only behind remoteSettings: true.

This does not automatically trust a Host, disable BrowserAuth, or alter the server's Origin checks. The deployment still needs trustedHosts for a Tailscale/LAN/reverse-proxy authority, and BrowserAuth remains on unless separately disabled.

## Failure modes and maintenance rules

- Unsupported bind addresses fail in the startup provider instead of being accepted and later rejected by WebServer.
- Bad ports, URLs, BrowserAuth modes, and malformed dangerous combinations fail before webStartup is provided.
- A missing connection/webserver capability fails with a message naming the expected public contract.
- If an official provider remains active because its patch row moved or changed name, the adapter refuses to start with a duplicate-provider error instead of silently composing two owners.
- A future upstream row can silently stop being targeted only if the loader changes its row IDs; composition tests and dsh --dump-config verification are release checks for this risk.
- A future upstream change to targeted connection config must be copied into ConnectionConfig automatically through the official schema where possible; the adapter still documents the row replacement as a deliberate compatibility boundary.
- The package keeps stock behavior as the default: loopback, BrowserAuth dsh, no remote Settings, and no advertised URL.
