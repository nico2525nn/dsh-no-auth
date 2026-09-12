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
  it('inserts one PWA row without replacing or duplicating official owners', () => {
    const upstreamRows = [
      { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver' },
      { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app' },
      { id: 'connection', name: '@deepseek-ai/dsh-client-connection' },
      { id: 'frontend-static', name: '@deepseek-ai/dsh-host-frontend-static' },
    ]
    const warnings: string[] = []
    const composed = applyEntryPatches(upstreamRows, pluginPatches(), message => warnings.push(message))

    expect(warnings).toEqual([])
    expect(composed.filter(row => row.id === 'webserver')).toHaveLength(1)
    expect(composed.filter(row => row.id === 'web-runtime')).toHaveLength(1)
    expect(composed.filter(row => row.id === 'connection')).toHaveLength(1)
    expect(composed.filter(row => row.id === 'frontend-static')).toHaveLength(1)
    expect(composed.filter(row => row.id === 'dsh-web-pwa')).toHaveLength(1)
    expect(composed.find(row => row.id === 'dsh-web-pwa')).toMatchObject({
      name: 'dsh-web-pwa',
      inject: ['webServer', 'connection'],
    })
  })

  it('declares the loader-recognized bundle patch', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
})
