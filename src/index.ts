/** Public entry point for the independent dsh-web-remote bundle. */

export {
  apply as applyStartup,
  Config as StartupConfig,
  WEB_STARTUP_SERVICE,
  type BrowserAuthMode,
  type BindHost,
  type WebStartupConfig,
  type WebStartupValues,
} from './startup.js'
export {
  apply as applyRuntime,
  Config as RuntimeConfig,
  resolveLanTrust,
  type WebRuntimeConfig,
  type WebRuntimeValues,
} from './runtime.js'
export {
  apply as applyConnection,
  Config as ConnectionConfig,
  cleanApplicationUrl,
  disableBrowserAuth,
  type ConnectionPluginConfig,
} from './connection.js'
