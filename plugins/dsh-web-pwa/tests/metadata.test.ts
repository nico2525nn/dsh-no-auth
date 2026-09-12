import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManifest, normalizePublicUrl, paths } from '../src/index.ts'

describe('PWA metadata', () => {
  it('uses a bootstrap start URL and Android-sized opaque PNG entries', () => {
    const manifest = JSON.parse(createManifest(null)) as {
      id: string
      start_url: string
      scope: string
      display: string
      icons: Array<{ src: string; sizes: string; type: string; purpose: string }>
    }
    expect(manifest).toMatchObject({
      id: '/',
      start_url: paths.start,
      scope: '/',
      display: 'standalone',
    })
    expect(manifest.icons).toEqual([
      { src: paths.icon192, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: paths.icon512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ])
  })

  it('can make the start URL explicit for a root public origin', () => {
    const publicUrl = normalizePublicUrl('https://nico.tailxxxx.ts.net')
    expect(publicUrl).toBe('https://nico.tailxxxx.ts.net/')
    const manifest = JSON.parse(createManifest(publicUrl)) as { start_url: string; scope: string }
    expect(manifest.start_url).toBe('https://nico.tailxxxx.ts.net/.dsh-pwa/start')
    expect(manifest.scope).toBe('https://nico.tailxxxx.ts.net/')
  })

  it('rejects path prefixes and non-HTTP public URLs', () => {
    expect(() => normalizePublicUrl('https://example.test/dsh')).toThrow('path prefixes')
    expect(() => normalizePublicUrl('file:///tmp/dsh')).toThrow('http:// or https://')
    expect(() => normalizePublicUrl('https://user@example.test')).toThrow('userinfo')
  })

  it('ships both PNG dimensions and an opaque favicon source', () => {
    const png192 = readFileSync(resolve('assets/icon-192.png'))
    const png512 = readFileSync(resolve('assets/icon-512.png'))
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png192.subarray(0, 8)).toEqual(pngSignature)
    expect(png512.subarray(0, 8)).toEqual(pngSignature)
    expect(readFileSync(resolve('assets/icon.svg'), 'utf8')).toContain('fill="#0b1020"')
  })
})
