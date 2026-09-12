# dsh-web-pwa

`dsh-web-pwa` is a separate DSH bundle for Android/Chrome PWA behavior. It is
intended to be installed with the normal profile plugin command and works with
the stock Web bundle as well as `dsh-web-remote`.

It fixes two independent upstream limitations:

- the shipped manifest starts at `/`, while DSH's root document is protected
  by the BrowserAuth token-to-cookie exchange;
- the shipped manifest advertises only a small SVG favicon, which is not a
  reliable install icon on Android.

The plugin replaces the manifest response at `/manifest.webmanifest`, serves
opaque 192×192 and 512×512 PNG icons with a non-transparent background, and
adds `/.dsh-pwa/start` as the manifest `start_url`. The start route performs no
RPC and reads no settings. It checks the official Host/Origin trust fence, then
redirects through `connection.authenticatedUrl()`:

- with normal DSH BrowserAuth, Android receives the current process launch
  token, exchanges it for the authority-bound cookie, and lands on a clean `/`;
- with the explicit `dsh-web-remote` BrowserAuth-disabled adapter, the same
  route redirects to clean `/` without adding a useless `?token=`.

This package does not disable authentication, modify `/api`, modify WebSocket
upgrades, add a service worker, or provide offline operation. The trust fence
and the existing powerful RPC surface remain upstream-owned.

## Install

From this checkout, build the package once and install it into the Web profile:

```sh
cd plugins/dsh-web-pwa
npm install
npm run build
cd ../..
dsh plugin --profile web add ./plugins/dsh-web-pwa
dsh --profile web --dump-config
```

For a published package:

```sh
dsh plugin --profile web add dsh-web-pwa
```

Removing it restores the stock manifest, favicon, and startup behavior on the
next launch:

```sh
dsh plugin --profile web remove dsh-web-pwa
```

The package is intentionally not a patch copy of `web-app`; its bundle patch
only inserts one row and does not replace any official row.

## Reverse proxy / advertised URL

The default `publicUrl: null` keeps the PWA start URL relative to the authority
from which the manifest was loaded. The bootstrap route uses the request Host
and, when supplied by a reverse proxy, the first `X-Forwarded-Proto` value.
Configure a canonical root URL when the proxy does not preserve those headers
or when you want the redirect to be explicit:

```yaml
- id: dsh-web-pwa
  name: dsh-web-pwa
  inject: [webServer, connection]
  config:
    publicUrl: https://nico.tailxxxx.ts.net/
```

`publicUrl` accepts only an absolute `http://` or `https://` root URL. Paths,
userinfo, query strings, and fragments are rejected because the current DSH
frontend is rooted at `/`. If `dsh-web-remote` is also installed, keep its
`advertiseUrl` and this `publicUrl` equal when both are configured. The PWA
route itself still requires the same trusted Host/Origin deployment policy;
this setting is not a trust grant.

For a Tailscale/LAN deployment, configure the remote bundle's trust fence as
well. Installing this PWA bundle alone must not make an arbitrary Host valid:

```sh
dsh web --no-open \
  --host 0.0.0.0 \
  --port 3080 \
  --trusted-host nico.tailxxxx.ts.net
```

If BrowserAuth is disabled through `dsh-web-remote`, retain the explicit
`--allow-unauthenticated-remote` requirement for a `0.0.0.0` bind. This PWA
plugin does not weaken that safety gate.

## What Android should request

After a clean profile install and launch, the important sequence is:

```text
GET /manifest.webmanifest       200 application/manifest+json
GET /.dsh-pwa/start              303 Location: /?token=<fresh process token>
GET /?token=<fresh token>        303 Set-Cookie + Location: /
GET /                            200 application UI
```

The token query is transient and is removed by the upstream exchange. A later
PWA launch repeats the bootstrap route, so a stale manifest does not contain a
token from a previous DSH process. When the cookie is still valid, the upstream
BrowserAuth implementation handles the repeated token safely and redirects to
the clean root.

## Tests

```sh
npm run typecheck
npm test
npm run build
npm run pack:check
```

The tests cover manifest/icon metadata, public URL validation, BrowserAuth-on
and auth-off redirect semantics, Host/Origin rejection, method handling, and
the real WebServer route registration. The parent repository's browser smoke
test should additionally open the printed URL with Chrome/Playwright and verify
that the actual DSH shell has no boot-failure or pending-plugin screen.

See [`docs/upstream-contracts.md`](docs/upstream-contracts.md) for the exact
upstream seams and compatibility risks.
