/** Native DSH plugin-settings card for Codex App Server capabilities. */

import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {
  CodexSettingsCardFace,
  CodexSettingsField,
} from './settings-card-controller.ts'
import type { CodexUiKey } from './locales.ts'
import css from './CodexSettingsCard.module.css'

export type CodexSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'codex-app-server'>
  & InjectFace<CodexSettingsCardFace>

interface FieldHeadProps {
  label: string
  controlId?: string
  overridden: boolean
  disabled: boolean
  t: (key: CodexUiKey) => string
  onReset: () => void
}

function FieldHead(props: FieldHeadProps): ReactNode {
  return (
    <div className={css.fieldHead}>
      {props.controlId === undefined
        ? <span className={css.fieldLabel}>{props.label}</span>
        : <label className={css.fieldLabel} htmlFor={props.controlId}>{props.label}</label>}
      {props.overridden
        ? (
          <span className={css.badges}>
            <span className={css.badge}>{props.t('settings.overridden')}</span>
            <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.t('settings.reset')}
            </button>
          </span>
        )
        : null}
    </div>
  )
}

function ToggleField(props: FieldHeadProps & {
  value: boolean
  hint: string
  onChange: (value: boolean) => void
}): ReactNode {
  return (
    <div className={css.field}>
      <FieldHead {...props} />
      <button
        type="button"
        role="switch"
        aria-checked={props.value}
        aria-label={`${props.label}: ${props.t(props.value ? 'settings.enabled' : 'settings.disabled')}`}
        className={css.switchRow}
        disabled={props.disabled}
        onClick={() => { props.onChange(!props.value) }}
      >
        <span className={css.switch} data-on={String(props.value)}><span className={css.thumb} /></span>
        <span>{props.t(props.value ? 'settings.enabled' : 'settings.disabled')}</span>
      </button>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

function TextField(props: FieldHeadProps & {
  id: string
  field: CodexSettingsField<string>
  hint: string
  placeholder?: string
  numeric?: boolean
  list?: string
  onChange: (value: string) => void
}): ReactNode {
  return (
    <div className={css.field}>
      <FieldHead {...props} controlId={props.id} />
      <input
        id={props.id}
        className={props.field.invalid ? `${css.input} ${css.inputInvalid}` : css.input}
        type="text"
        value={props.field.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        list={props.list}
        inputMode={props.numeric === true ? 'numeric' : undefined}
        aria-invalid={props.field.invalid || undefined}
        onChange={(event) => { props.onChange(event.target.value) }}
      />
      <p className={props.field.invalid ? css.invalid : css.hint}>
        {props.field.invalid ? props.t('settings.invalid') : props.hint}
      </p>
    </div>
  )
}

const SUGGESTED_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
] as const

/** Render the Codex card inside Settings → Plugins → Plugin configuration. */
export function CodexSettingsCard(props: CodexSettingsCardProps): ReactNode {
  const [open, setOpen] = useState(false)
  const state = props.useCodexSettings(snapshot => snapshot)
  if (!state.available) return null
  const disabled = !state.writable || state.saving
  return (
    <li className={`${css.card}${open ? ` ${css.cardOpen}` : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${props.t(open ? 'settings.collapse' : 'settings.expand')}: ${props.t('settings.title')}`}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{props.t('settings.title')}</span>
          <span className={css.description}>{props.t('settings.description')}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{props.t('settings.unsaved')}</span> : null}
        <span className={css.chevron} data-open={String(open)} aria-hidden>⌄</span>
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly}>{props.t('settings.readOnly')}</p> : null}
            <ToggleField
              label={props.t('settings.imageGeneration')}
              hint={props.t('settings.imageGenerationHint')}
              value={state.imageGenerationEnabled.value}
              overridden={state.imageGenerationEnabled.overridden}
              disabled={disabled}
              t={props.t}
              onChange={(value) => { props.editBoolean('imageGenerationEnabled', value) }}
              onReset={() => { props.reset('imageGenerationEnabled') }}
            />
            <ToggleField
              label={props.t('settings.webSearch')}
              hint={props.t('settings.webSearchHint')}
              value={state.webSearchEnabled.value}
              overridden={state.webSearchEnabled.overridden}
              disabled={disabled}
              t={props.t}
              onChange={(value) => { props.editBoolean('webSearchEnabled', value) }}
              onReset={() => { props.reset('webSearchEnabled') }}
            />
            <TextField
              id="codex-web-search-model"
              label={props.t('settings.webSearchModel')}
              hint={props.t('settings.webSearchModelHint')}
              placeholder={props.t('settings.followMainModel')}
              field={state.webSearchModel}
              overridden={state.webSearchModel.overridden}
              disabled={disabled}
              list="codex-web-search-models"
              t={props.t}
              onChange={(value) => { props.editText('webSearchModel', value) }}
              onReset={() => { props.reset('webSearchModel') }}
            />
            <datalist id="codex-web-search-models">
              {SUGGESTED_MODELS.map(model => <option key={model} value={model} />)}
            </datalist>
            <TextField
              id="codex-web-search-max-results"
              label={props.t('settings.webSearchMaxResults')}
              hint={props.t('settings.webSearchMaxResultsHint')}
              field={state.webSearchMaxResults}
              overridden={state.webSearchMaxResults.overridden}
              disabled={disabled}
              numeric
              t={props.t}
              onChange={(value) => { props.editText('webSearchMaxResults', value) }}
              onReset={() => { props.reset('webSearchMaxResults') }}
            />
            <p className={css.applies}>{props.t('settings.applies')}</p>
            <div className={css.footer}>
              {state.failed ? <p className={css.failed}>{props.t('settings.saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!state.dirty || state.saving}
                onClick={props.discard}
              >
                {props.t('settings.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={!state.writable || !state.dirty || state.invalid || state.saving}
                onClick={props.save}
              >
                {props.t(state.saving ? 'settings.saving' : 'settings.save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
