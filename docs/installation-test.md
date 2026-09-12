# Profile installation test recipe

The repository's automated composition test checks the same row replacement function used by DSH's loader. For a release smoke test against a real CLI, use an isolated DSH_HOME and the installed or packed package:

~~~sh
rm -rf /tmp/dsh-web-remote-home
DSH_HOME=/tmp/dsh-web-remote-home dsh plugin --profile web add .
DSH_HOME=/tmp/dsh-web-remote-home dsh --profile web --dump-config > /tmp/dsh-web-remote-config.yml
DSH_HOME=/tmp/dsh-web-remote-home dsh plugin --profile web remove dsh-web-remote
DSH_HOME=/tmp/dsh-web-remote-home dsh --profile web --dump-config > /tmp/dsh-web-stock-config.yml
~~~

Check that the first dump contains one active dsh-web-remote/startup, dsh-web-remote/runtime, and dsh-web-remote/connection row; `web-startup` and `web-runtime` are disabled, while the official dual-face `connection` row remains active. Also check that the rendered Web index contains the official `@deepseek-ai/dsh-client-connection/client.js` entry. The final dump contains the stock @deepseek-ai/dsh-web-app rows and no dsh-web-remote row. The command uses DSH's own profile reconciliation; no manual edit to the profile manifest or patch file is part of installation. The two disabled stock rows are required because the current patch engine treats name as an expected-name guard and has no row-delete or row-rename operation; replacing the connection row would incorrectly remove its browser half.

For a real CLI smoke test against the current published channel, the repository also has an opt-in Node test. It uses a temporary `DSH_HOME`, installs this checkout through the plugin command, verifies the auth-on and auth-off HTTP/upgrade surfaces, and removes the package before checking stock restoration:

~~~sh
pnpm run build
DSH_WEB_REMOTE_E2E=1 npm run test:e2e
~~~

Set `DSH_WEB_REMOTE_DSH=@deepseek-ai/dsh@0.1.5-rc.1` for the requested RC1 compatibility baseline, or use `@deepseek-ai/dsh@next` to exercise the next published channel.

The default unit suite does not resolve or boot a full DSH distribution; this opt-in test intentionally does so because it downloads the DSH CLI and takes roughly half a minute on a warm cache.
