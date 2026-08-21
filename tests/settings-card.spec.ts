import { describe, expect, it, vi } from 'vitest'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  CodexSettingsCardController,
  type CodexCapabilitySettingsView,
} from '../src/client/settings-card-controller.ts'

class FakeScope implements SettingsScope<CodexCapabilitySettingsView> {
  private readonly listeners = new Set<() => void>()
  readonly setCalls = vi.fn<(field: string, value: unknown) => Promise<void>>()
  readonly unsetCalls = vi.fn<(field: string) => Promise<void>>()
  private snapshot: SettingsScopeSnapshot<CodexCapabilitySettingsView>

  constructor(
    private readonly base: Required<CodexCapabilitySettingsView>,
    user: CodexCapabilitySettingsView = {},
  ) {
    this.snapshot = this.next(user, 0)
    this.setCalls.mockImplementation(async (field, value) => {
      const user = { ...(this.snapshot.user as CodexCapabilitySettingsView), [field]: value }
      this.snapshot = this.next(user, (this.snapshot.revision ?? 0) + 1)
      this.publish()
    })
    this.unsetCalls.mockImplementation(async (field) => {
      const user = { ...(this.snapshot.user as CodexCapabilitySettingsView) }
      Reflect.deleteProperty(user, field)
      this.snapshot = this.next(user, (this.snapshot.revision ?? 0) + 1)
      this.publish()
    })
  }

  getSnapshot(): SettingsScopeSnapshot<CodexCapabilitySettingsView> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(field: string, value: unknown): Promise<void> {
    return this.setCalls(field, value)
  }

  unset(field: string): Promise<void> {
    return this.unsetCalls(field)
  }

  private next(
    user: CodexCapabilitySettingsView,
    revision: number,
  ): SettingsScopeSnapshot<CodexCapabilitySettingsView> {
    return {
      status: 'ready',
      value: { ...this.base, ...user },
      base: { ...this.base },
      user: { ...user },
      revision,
      writable: true,
      mode: 'host',
    }
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

const BASE = {
  imageGenerationEnabled: true,
  webSearchEnabled: true,
  webSearchModel: '',
  webSearchMaxResults: 8,
} satisfies Required<CodexCapabilitySettingsView>

describe('Codex settings card controller', () => {
  it('stages all capability controls and commits them through the settings scope', async () => {
    const scope = new FakeScope(BASE)
    const face = new CodexSettingsCardController(scope).inject()

    face.editBoolean('imageGenerationEnabled', false)
    face.editBoolean('webSearchEnabled', false)
    face.editText('webSearchModel', 'gpt-5.4-mini')
    face.editText('webSearchMaxResults', '4')
    expect(face.hooks.codexSettings.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: false,
      imageGenerationEnabled: { value: false, overridden: true },
      webSearchModel: { value: 'gpt-5.4-mini', overridden: true },
      webSearchMaxResults: { value: '4', overridden: true },
    })

    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.codexSettings.getSnapshot().saving).toBe(false)
      expect(face.hooks.codexSettings.getSnapshot().dirty).toBe(false)
    })
    expect(scope.setCalls).toHaveBeenCalledWith('imageGenerationEnabled', false)
    expect(scope.setCalls).toHaveBeenCalledWith('webSearchEnabled', false)
    expect(scope.setCalls).toHaveBeenCalledWith('webSearchModel', 'gpt-5.4-mini')
    expect(scope.setCalls).toHaveBeenCalledWith('webSearchMaxResults', 4)
  })

  it('stages reset as an unset back to the composition layer', async () => {
    const scope = new FakeScope(BASE, { imageGenerationEnabled: false })
    const face = new CodexSettingsCardController(scope).inject()

    face.reset('imageGenerationEnabled')
    expect(face.hooks.codexSettings.getSnapshot().imageGenerationEnabled).toEqual({
      value: true,
      overridden: false,
      invalid: false,
    })
    face.save()
    await vi.waitFor(() => { expect(face.hooks.codexSettings.getSnapshot().dirty).toBe(false) })
    expect(scope.unsetCalls).toHaveBeenCalledWith('imageGenerationEnabled')
  })

  it('keeps invalid result caps staged and blocks the write', () => {
    const scope = new FakeScope(BASE)
    const face = new CodexSettingsCardController(scope).inject()

    face.editText('webSearchMaxResults', '8')
    expect(face.hooks.codexSettings.getSnapshot().dirty).toBe(false)
    face.editText('webSearchMaxResults', '0')
    expect(face.hooks.codexSettings.getSnapshot()).toMatchObject({ dirty: true, invalid: true })
    face.save()
    expect(scope.setCalls).not.toHaveBeenCalled()
  })
})
