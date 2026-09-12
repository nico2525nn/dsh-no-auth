# dsh-web-pwa upstream contracts

The implementation was checked against the current upstream
`deepseek-ai/deepseek-harness` `master` at commit
`c291e7961a515f6d7af9304e7fd1d257929aef26` (2026-09-10) and the installed
`0.1.5-rc.2` package line. The earlier `0.1.5-rc.1` line is covered by the
same public method shape. The source of truth is always the upstream package,
not this document or a copied private implementation.

## Owned upstream pieces

| Concern | Current owner | Contract used | Override scope |
| --- | --- | --- | --- |
| HTTP listener and route precedence | `packages/host/webserver/src/index.ts` | `webServer.register({ kind: 'exact', path, handler })`; named routes precede the fallback | Add five exact routes; do not replace WebServer |
| Browser Host/Origin fence | `packages/client/connection/src/rpc-host.ts` + `api-request-trust.ts` | `connection.requestRejection(request)` returns `403`, `401`, or `undefined` | Reject `403`; deliberately ignore only `401` for public bootstrap assets |
| BrowserAuth token/cookie exchange | `packages/client/connection/src/browser-auth.ts` through `rpc-host.ts` | `connection.authenticatedUrl(baseUrl)` | Delegate; no token, cookie, HMAC, or BrowserAuth copy |
| Root index auth | `packages/host/frontend-static/src/index.ts` | `connection.authorizeIndex(req, res)` on `/` and `/index.html` | Leave untouched |
| Frontend manifest link | `apps/web/index.html`, built by `@deepseek-ai/dsh-web-frontend` | Current link resolves to `/manifest.webmanifest` | Register an exact route at that existing URL |
| Installed icon | `apps/web/public/favicon.svg` and manifest | Current manifest has one SVG `sizes: any` icon | Register the existing favicon path plus namespaced PNGs |
| Bundle loading | DSH bundle loader and `dsh.bundle.patch` | package manifest points to `./cordis.patch.yml`; `insert` adds an ordinary row | One inserted row; no duplicate official IDs |

## Why the bootstrap route is public

The Android shortcut has to reach a route before it has a DSH cookie. The route
does not serve the application, call RPC, or expose settings. It first calls
the official `requestRejection()` method and only treats its authentication
result (`401`) as expected. A `403` from an untrusted Host or cross-site Origin
is returned unchanged as a forbidden response. The next response is a 303 to
`authenticatedUrl()`, so BrowserAuth remains the only owner of launch-token
generation, cookie naming, authority binding, expiry, and token exchange.

Ignoring the 401 from `requestRejection()` is intentionally limited to the
five PWA resources. The plugin does not monkey-patch the Connection service or
change `/api`, RPC, SSE, WebSocket, or root index authorization.

## Android icon choices

The upstream SVG is a 50×50 mark with no opaque background. Android launchers
are allowed to reject or rasterize that form poorly. This plugin ships a
single source SVG with a dark opaque rounded-square background and generated
192×192 and 512×512 RGBA PNGs. Both manifest entries declare `any maskable`.
The files are static package assets, not generated at startup, so a missing
published asset is a packaging error rather than a runtime fallback to a white
placeholder.

## Failure modes and compatibility policy

Startup fails with an explicit `dsh-web-pwa: incompatible ...` error when the
WebServer no longer exposes `register()` or Connection no longer exposes both
`requestRejection()` and `authenticatedUrl()`. This is preferable to silently
serving an auth-bypassing route. A malformed `publicUrl` is rejected before
route registration. A malformed/missing request Host returns a controlled 400
from the bootstrap handler; an untrusted Host/Origin remains 403.

The package uses semver ranges for DSH dependencies and does not pin the host
DSH version. If a future upstream release changes the public method types or
the WebServer route contract, update this adapter and its composition tests.
Do not copy `BrowserAuth` or replace `web-app` as a compatibility shortcut.
