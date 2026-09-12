import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'

function pluginPatches(): PatchOptions[] {
  return yaml.load(readFileSync(resolve('cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  }) as PatchOptions[]
}

describe('profile composition', () => {
  it('replaces only official rows, with no duplicate loader entries', () => {
    const upstreamRows = [
      { id: 'web-startup', name: '@deepseek-ai/dsh-web-app/startup' },
      { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', inject: ['webStartup'] },
      { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app', inject: ['webStartup'] },
      { id: 'connection', name: '@deepseek-ai/dsh-client-connection', inject: ['webRuntime'] },
      { id: 'frontend-static', name: '@deepseek-ai/dsh-host-frontend-static', inject: ['webServer', 'connection'] },
    ]
    const warnings: string[] = []
    const composed = applyEntryPatches(upstreamRows, pluginPatches(), message => warnings.push(message))

    expect(warnings).toEqual([])
    expect(composed.filter(row => row.id === 'web-startup')).toHaveLength(1)
    expect(composed.filter(row => row.id === 'web-runtime')).toHaveLength(1)
    expect(composed.filter(row => row.id === 'connection')).toHaveLength(1)
    expect(composed.find(row => row.id === 'web-startup')).toMatchObject({
      name: '@deepseek-ai/dsh-web-app/startup',
      disabled: true,
    })
    expect(composed.find(row => row.id === 'web-runtime')).toMatchObject({
      name: '@deepseek-ai/dsh-web-app',
      disabled: true,
    })
    expect(composed.find(row => row.id === 'connection')).toMatchObject({
      name: '@deepseek-ai/dsh-client-connection',
    })
    expect(composed.find(row => row.id === 'connection')?.disabled).toBeUndefined()
    expect(composed.filter(row => row.name === 'dsh-web-remote/startup')).toHaveLength(1)
    expect(composed.filter(row => row.name === 'dsh-web-remote/runtime')).toHaveLength(1)
    expect(composed.filter(row => row.name === 'dsh-web-remote/connection')).toHaveLength(1)
    expect(composed.find(row => row.name === 'dsh-web-remote/connection')?.inject)
      .toEqual(['connection', 'webStartup'])
    expect(composed.find(row => row.id === 'webserver')?.name).toBe('@deepseek-ai/dsh-host-webserver')
    expect(composed.find(row => row.id === 'frontend-static')?.name).toBe('@deepseek-ai/dsh-host-frontend-static')
  })

  it('declares the loader-recognized bundle manifest and patch path', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
})
