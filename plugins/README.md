# DSH companion plugins

This directory contains independently installable DSH bundles. Each package
has its own `package.json`, `dsh.bundle.patch`, source, tests, and release
artifacts; no profile `cordis.patch.yml` row needs to be copied by hand.

- [`dsh-web-pwa/`](dsh-web-pwa/): Android-friendly PWA manifest, opaque 192/512
  icons, and an auth-preserving PWA `start_url` bootstrap route.

Build and install a package from the repository root with:

```sh
cd plugins/dsh-web-pwa
npm install
npm run build
cd ../..
dsh plugin --profile web add ./plugins/dsh-web-pwa
```
