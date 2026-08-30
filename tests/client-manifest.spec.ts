import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageManifest {
  readonly dsh?: {
    readonly client?: {
      readonly inject?: readonly string[]
    }
  }
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

describe('browser plugin manifest', () => {
  it('names the current Chat slot owner instead of the removed client runtime', () => {
    const inject = manifest.dsh?.client?.inject
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-chat')
    expect(inject).toContain('@deepseek-ai/dsh-client-ui-renderer')
    expect(inject).not.toContain('@deepseek-ai/dsh-client-runtime')
  })
})
