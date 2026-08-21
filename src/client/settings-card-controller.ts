/** Staged browser form over the Codex capability settings namespace. */

import type {
  SettingsScope,
  SettingsScopeSnapshot,
  SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Duplicated intentionally: browser bundles must not import the Host module. */
export const CODEX_SETTINGS_NAMESPACE = 'llm-codex-app-server'

export interface CodexCapabilitySettingsView {
  imageGenerationEnabled?: boolean
  webSearchEnabled?: boolean
  webSearchModel?: string
  webSearchMaxResults?: number
}

type EditableField = keyof CodexCapabilitySettingsView
const RESET = Symbol('reset-codex-setting')
type DraftValue = boolean | string | typeof RESET

const DEFAULTS: Required<CodexCapabilitySettingsView> = {
  imageGenerationEnabled: true,
  webSearchEnabled: true,
  webSearchModel: '',
  webSearchMaxResults: 8,
}

/** Small client-safe store; importing the runtime bundle itself would execute its browser loader in SSR tests. */
class SnapshotCell<T> implements SnapshotStore<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: T): void {
    this.value = next
    for (const listener of this.listeners) listener()
  }

  update(mutator: (draft: T) => void): void {
    const next = structuredClone(this.value)
    mutator(next)
    this.set(next)
  }
}

/** One projected field in the card. */
export interface CodexSettingsField<T> {
  readonly value: T
  readonly overridden: boolean
  readonly invalid: boolean
}

/** Complete state rendered by the Codex settings card. */
export interface CodexSettingsCardState {
  readonly available: boolean
  readonly writable: boolean
  readonly saving: boolean
  readonly failed: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly imageGenerationEnabled: CodexSettingsField<boolean>
  readonly webSearchEnabled: CodexSettingsField<boolean>
  readonly webSearchModel: CodexSettingsField<string>
  readonly webSearchMaxResults: CodexSettingsField<string>
}

/** Registration-side face bound to the card's slot component. */
export interface CodexSettingsCardFace {
  hooks: {
    codexSettings: SnapshotStore<CodexSettingsCardState>
  }
  editBoolean(field: 'imageGenerationEnabled' | 'webSearchEnabled', value: boolean): void
  editText(field: 'webSearchModel' | 'webSearchMaxResults', value: string): void
  reset(field: EditableField): void
  discard(): void
  save(): void
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function hasOwn(snapshot: SettingsScopeSnapshot<CodexCapabilitySettingsView>, field: EditableField): boolean {
  return Object.hasOwn(object(snapshot.user), field)
}

function same(left: unknown, right: unknown): boolean {
  return Object.is(left, right)
}

/** Owns drafts and revision-safe field writes for one settings card. */
export class CodexSettingsCardController {
  private readonly drafts = new Map<EditableField, DraftValue>()
  private readonly store: SnapshotStore<CodexSettingsCardState>
  private saving = false
  private failed = false

  constructor(private readonly scope: SettingsScope<CodexCapabilitySettingsView>) {
    this.store = new SnapshotCell(this.project())
    scope.subscribe(() => { this.publish() })
  }

  inject(): CodexSettingsCardFace {
    return {
      hooks: { codexSettings: this.store },
      editBoolean: (field, value) => { this.stage(field, value) },
      editText: (field, value) => { this.stage(field, value) },
      reset: (field) => { this.reset(field) },
      discard: () => { this.discard() },
      save: () => { void this.save() },
    }
  }

  private stage(field: EditableField, value: boolean | string): void {
    const effective = field === 'webSearchMaxResults'
      ? String(this.effective(field))
      : this.effective(field)
    if (same(value, effective)) this.drafts.delete(field)
    else this.drafts.set(field, value)
    this.failed = false
    this.publish()
  }

  private reset(field: EditableField): void {
    if (hasOwn(this.scope.getSnapshot(), field)) this.drafts.set(field, RESET)
    else this.drafts.delete(field)
    this.failed = false
    this.publish()
  }

  private discard(): void {
    if (this.saving) return
    this.drafts.clear()
    this.failed = false
    this.publish()
  }

  private async save(): Promise<void> {
    const state = this.project()
    if (!state.writable || !state.dirty || state.invalid || this.saving) return
    const plan = [...this.drafts.entries()]
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const [field, draft] of plan) {
      try {
        if (draft === RESET) await this.scope.unset(field)
        else await this.scope.set(field, this.storedValue(field, draft))
      } catch (_writeFailure) {
        landed = false
        continue
      }
      const snapshot = this.scope.getSnapshot()
      const user = object(snapshot.user)
      landed = draft === RESET
        ? !Object.hasOwn(user, field) && landed
        : Object.hasOwn(user, field) && same(user[field], this.storedValue(field, draft)) && landed
    }
    if (landed) this.drafts.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private storedValue(field: EditableField, draft: Exclude<DraftValue, typeof RESET>): boolean | string | number {
    if (field !== 'webSearchMaxResults') return draft
    return Number(draft)
  }

  private effective(field: EditableField): boolean | string | number {
    const value = object(this.scope.getSnapshot().value)[field]
    return value === undefined ? DEFAULTS[field] : value as boolean | string | number
  }

  private inherited(field: EditableField): boolean | string | number {
    const value = object(this.scope.getSnapshot().base)[field]
    return value === undefined ? DEFAULTS[field] : value as boolean | string | number
  }

  private value(field: EditableField): boolean | string | number {
    const draft = this.drafts.get(field)
    if (draft === undefined) return this.effective(field)
    return draft === RESET ? this.inherited(field) : draft
  }

  private overridden(field: EditableField): boolean {
    const draft = this.drafts.get(field)
    if (draft === RESET) return false
    if (draft !== undefined) return true
    return hasOwn(this.scope.getSnapshot(), field)
  }

  private project(): CodexSettingsCardState {
    const snapshot = this.scope.getSnapshot()
    const maxResults = String(this.value('webSearchMaxResults'))
    const parsedMaxResults = Number(maxResults)
    const maxResultsInvalid = maxResults.trim().length === 0
      || !Number.isSafeInteger(parsedMaxResults)
      || parsedMaxResults <= 0
    const model = String(this.value('webSearchModel'))
    const modelInvalid = model.length > 0
      && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      saving: this.saving,
      failed: this.failed,
      dirty: this.drafts.size > 0,
      invalid: maxResultsInvalid || modelInvalid,
      imageGenerationEnabled: {
        value: Boolean(this.value('imageGenerationEnabled')),
        overridden: this.overridden('imageGenerationEnabled'),
        invalid: false,
      },
      webSearchEnabled: {
        value: Boolean(this.value('webSearchEnabled')),
        overridden: this.overridden('webSearchEnabled'),
        invalid: false,
      },
      webSearchModel: {
        value: model,
        overridden: this.overridden('webSearchModel'),
        invalid: modelInvalid,
      },
      webSearchMaxResults: {
        value: maxResults,
        overridden: this.overridden('webSearchMaxResults'),
        invalid: maxResultsInvalid,
      },
    }
  }

  private publish(): void {
    this.store.set(this.project())
  }
}
