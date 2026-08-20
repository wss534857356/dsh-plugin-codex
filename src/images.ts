/** Durable projection and transient hydration of Codex image content. */

import { createHash } from 'node:crypto'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { LlmError, OFFLOADED_IMAGE_TEXT } from '@deepseek-ai/dsh-llm'
import type {
  CodexAppServerEvent,
  CodexAppServerHydratedToolResult,
  CodexAppServerToolResult,
  JsonValue,
} from './runner.ts'

const IMAGE_MARKER_KIND = 'dsh-image-attachment'
const IMAGE_MARKER_VERSION = 1
const IMAGE_MEDIA_TYPES = new Set<ImageMediaType>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
const IMAGE_DETAILS = new Set(['auto', 'low', 'high', 'original'])
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

interface JsonObject {
  readonly [key: string]: unknown
}

/** Attachment operations needed by the Codex image bridge. */
export interface CodexImageStorePort {
  readonly imageLimits: ImageAttachmentLimits
  validateImage(input: SaveImageAttachment): Promise<void>
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

/** One App Server event after binary outputs have moved to durable attachments. */
export interface ExternalizedCodexEvent {
  readonly event: CodexAppServerEvent
  readonly images: readonly ImageAttachmentRef[]
}

interface DecodedImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name?: string
}

interface PendingOutputImage {
  readonly index: number
  readonly input: DecodedImage
}

function object(value: unknown, label: string, code: 'INVALID_HISTORY' | 'MALFORMED_RESPONSE'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError(`${label} must be a JSON object`, code)
  }
  return value as JsonObject
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return value as number
}

function attachmentRef(value: unknown, label: string): ImageAttachmentRef {
  const candidate = object(value, label, 'INVALID_HISTORY')
  if (typeof candidate.attachmentId !== 'string' || candidate.attachmentId.length === 0
    || typeof candidate.mediaType !== 'string'
    || !IMAGE_MEDIA_TYPES.has(candidate.mediaType as ImageMediaType)
    || (candidate.name !== undefined && (typeof candidate.name !== 'string' || candidate.name.length === 0))) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return {
    attachmentId: AttachmentId(candidate.attachmentId),
    mediaType: candidate.mediaType as ImageMediaType,
    bytes: positiveInteger(candidate.bytes, `${label}.bytes`),
    width: positiveInteger(candidate.width, `${label}.width`),
    height: positiveInteger(candidate.height, `${label}.height`),
    ...(candidate.name === undefined ? {} : { name: candidate.name as string }),
  }
}

function referenceValue(ref: ImageAttachmentRef): JsonValue {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

/** Durable adapter-private marker placed where App Server expects an image URL. */
export function imageAttachmentMarker(ref: ImageAttachmentRef): JsonValue {
  return {
    kind: IMAGE_MARKER_KIND,
    version: IMAGE_MARKER_VERSION,
    attachment: referenceValue(ref),
  }
}

function markerReference(value: unknown, label: string): ImageAttachmentRef {
  const marker = object(value, label, 'INVALID_HISTORY')
  if (marker.kind !== IMAGE_MARKER_KIND || marker.version !== IMAGE_MARKER_VERSION) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return attachmentRef(marker.attachment, `${label}.attachment`)
}

function imageDetail(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !IMAGE_DETAILS.has(value)) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return value
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const normalized = value.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name.length === 0 ? undefined : name
}

function decodedBase64(
  encoded: string,
  mediaType: ImageMediaType,
  limits: ImageAttachmentLimits,
  label: string,
  name?: string,
): DecodedImage {
  const maximumEncodedBytes = 4 * Math.ceil(limits.maxImageBytes / 3)
  if (encoded.length === 0
    || encoded.length > maximumEncodedBytes
    || encoded.length % 4 !== 0
    || !BASE64.test(encoded)) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  const data = Buffer.from(encoded, 'base64')
  if (data.byteLength === 0
    || data.byteLength > limits.maxImageBytes
    || data.toString('base64') !== encoded) {
    throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  }
  return { data, mediaType, ...(name === undefined ? {} : { name }) }
}

function decodedDataUrl(
  value: string,
  limits: ImageAttachmentLimits,
  label: string,
): DecodedImage | undefined {
  if (!value.startsWith('data:')) return undefined
  const separator = value.indexOf(',')
  if (separator < 0) throw new LlmError(`Codex App Server returned invalid ${label}`, 'MALFORMED_RESPONSE')
  const header = value.slice(5, separator)
  const match = /^(image\/(?:png|jpeg|webp|gif));base64$/u.exec(header)
  if (match === null) throw new LlmError(`Codex App Server returned unsupported ${label}`, 'UNSUPPORTED_CONTENT')
  return decodedBase64(
    value.slice(separator + 1),
    match[1] as ImageMediaType,
    limits,
    label,
  )
}

function imageKey(input: DecodedImage): string {
  return `${input.mediaType}:${createHash('sha256').update(input.data).digest('hex')}`
}

function base64Length(bytes: number, label: string): number {
  const length = Math.ceil(bytes / 3) * 4
  if (!Number.isSafeInteger(length)) {
    throw new LlmError(`Codex history contains invalid ${label}`, 'INVALID_HISTORY')
  }
  return length
}

function markerLength(value: unknown, label: string): number {
  return base64Length(markerReference(value, label).bytes, `${label}.attachment.bytes`)
}

function collectModelImageLengths(item: JsonValue, label: string, lengths: number[]): void {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return
  const values = item.type === 'message' && Array.isArray(item.content)
    ? item.content
    : item.type === 'function_call_output' && Array.isArray(item.output)
      ? item.output
      : undefined
  if (values === undefined) return
  for (const [index, value] of values.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.type !== 'input_image' || typeof value.image_url === 'string') continue
    lengths.push(markerLength(value.image_url, `${label}[${index}].image_url`))
  }
}

function replaceOldestModelImages(
  item: JsonValue,
  remaining: { count: number },
): JsonValue {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
  const field = item.type === 'message' && Array.isArray(item.content)
    ? 'content'
    : item.type === 'function_call_output' && Array.isArray(item.output)
      ? 'output'
      : undefined
  if (field === undefined) return item
  const values = item[field] as JsonValue[]
  let next: JsonValue[] | undefined
  for (const [index, value] of values.entries()) {
    const replace = remaining.count > 0
      && value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.type === 'input_image'
      && typeof value.image_url !== 'string'
    if (replace) {
      remaining.count -= 1
      next ??= values.slice(0, index)
      next.push({ type: 'input_text', text: OFFLOADED_IMAGE_TEXT })
    } else {
      next?.push(value)
    }
  }
  return next === undefined ? item : { ...item, [field]: next }
}

/**
 * Bound only marker fields that will be hydrated into model-visible image input.
 * Provider trajectory markers such as imageGeneration.result are never counted.
 */
export function boundRequestImageHistory(
  history: readonly JsonValue[],
  maxRequestImageBytes: number,
): JsonValue[] {
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new LlmError('Codex maxRequestImageBytes must be a positive safe integer', 'INVALID_REQUEST')
  }
  const lengths: number[] = []
  for (const [index, item] of history.entries()) {
    collectModelImageLengths(item, `history[${index}]`, lengths)
  }
  let total = 0
  for (const length of lengths) {
    total += length
    if (!Number.isSafeInteger(total)) {
      throw new LlmError('Codex history image payload length overflowed', 'INVALID_HISTORY')
    }
  }
  let count = 0
  for (const length of lengths) {
    if (total <= maxRequestImageBytes) break
    total -= length
    count += 1
  }
  if (count === 0) return [...history]
  const remaining = { count }
  return history.map(item => replaceOldestModelImages(item, remaining))
}

/**
 * Move provider image bytes out of events and restore durable markers only at
 * App Server transport boundaries. One instance belongs to one model request.
 */
export class NativeImageBridge {
  private readonly references = new Map<string, ImageAttachmentRef>()
  private readonly supplied = new Set<string>()
  private readonly published = new Set<string>()
  private readonly hydrated = new Map<string, Promise<string>>()
  private readonly harnessCallIds = new Set<string>()
  private storeValue: CodexImageStorePort | undefined

  constructor(private readonly resolveStore: () => CodexImageStorePort | undefined) {}

  /** Classify durable history images so supplied echoes and historical outputs stay distinct. */
  rememberHistory(history: readonly JsonValue[]): void {
    for (const item of history) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)
        && item.type === 'function_call'
        && item.namespace === 'deepseek_harness'
        && typeof item.call_id === 'string') {
        this.harnessCallIds.add(item.call_id)
      }
    }
    for (const [itemIndex, item] of history.entries()) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      if (item.type === 'message' && Array.isArray(item.content)) {
        this.rememberContentMarkers(item.content, `history[${itemIndex}].content`, 'supplied')
      } else if (item.type === 'function_call_output' && Array.isArray(item.output)) {
        const origin = typeof item.call_id === 'string' && this.harnessCallIds.has(item.call_id)
          ? 'supplied'
          : 'published'
        this.rememberContentMarkers(item.output, `history[${itemIndex}].output`, origin)
      }
    }
  }

  /** Externalize binary fields in one live App Server event. */
  async externalize(event: CodexAppServerEvent): Promise<ExternalizedCodexEvent> {
    if (event.kind !== 'notification') return { event, images: [] }
    if (event.method === 'item/completed') return this.externalizeImageGeneration(event)
    if (event.method === 'rawResponseItem/completed') return this.externalizeRawItem(event)
    return { event, images: [] }
  }

  /** Replace durable markers with verified data URLs for cold thread injection. */
  async hydrateHistory(history: readonly JsonValue[], signal?: AbortSignal): Promise<JsonValue[]> {
    this.rememberHistory(history)
    return Promise.all(history.map((item, index) => this.hydrateItem(item, `history[${index}]`, signal)))
  }

  /** Translate one durable user-message content array to App Server v2 UserInput. */
  async hydrateUserInput(content: readonly JsonValue[], signal?: AbortSignal): Promise<JsonValue[]> {
    if (content.length === 0) {
      throw new LlmError('Codex history contains an empty user input', 'INVALID_HISTORY')
    }
    return Promise.all(content.map(async (value, index): Promise<JsonValue> => {
      const item = object(value, `userInput[${index}]`, 'INVALID_HISTORY')
      if (item.type === 'input_text' && typeof item.text === 'string') {
        return { type: 'text', text: item.text, text_elements: [] }
      }
      if (item.type === 'input_image' && typeof item.image_url !== 'string') {
        const ref = markerReference(item.image_url, `userInput[${index}].image_url`)
        this.supplied.add(String(ref.attachmentId))
        const detail = imageDetail(item.detail, `userInput[${index}].detail`)
        return {
          type: 'image',
          url: await this.dataUrl(ref, signal),
          ...(detail === undefined ? {} : { detail }),
        }
      }
      throw new LlmError(`Codex history contains unsupported userInput[${index}]`, 'INVALID_HISTORY')
    }))
  }

  /** Translate one durable Harness tool result to App Server callback content items. */
  async hydrateToolResult(
    result: CodexAppServerToolResult,
    signal?: AbortSignal,
  ): Promise<CodexAppServerHydratedToolResult> {
    const contentItems = typeof result.output === 'string'
      ? [{ type: 'inputText', text: result.output } satisfies JsonValue]
      : await this.hydrateToolOutput(result.output, signal)
    return {
      callId: result.callId,
      contentItems: contentItems.length === 0 ? [{ type: 'inputText', text: '' }] : contentItems,
      success: result.success,
    }
  }

  private rememberContentMarkers(
    values: readonly JsonValue[],
    label: string,
    origin: 'supplied' | 'published',
  ): void {
    for (const [index, value] of values.entries()) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || value.type !== 'input_image' || typeof value.image_url === 'string') continue
      const ref = markerReference(value.image_url, `${label}[${index}].image_url`)
      ;(origin === 'supplied' ? this.supplied : this.published).add(String(ref.attachmentId))
    }
  }

  private store(): CodexImageStorePort {
    this.storeValue ??= this.resolveStore()
    if (this.storeValue === undefined) {
      throw new LlmError(
        'Codex image conversion requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    return this.storeValue
  }

  private async save(input: DecodedImage): Promise<ImageAttachmentRef> {
    const key = imageKey(input)
    const known = this.references.get(key)
    if (known !== undefined) {
      if (known.name !== undefined || input.name === undefined) return known
      const named = { ...known, name: input.name }
      this.references.set(key, named)
      return named
    }
    const saved = await this.store().saveImage(input)
    this.references.set(key, saved)
    return saved
  }

  private publish(ref: ImageAttachmentRef): ImageAttachmentRef[] {
    const id = String(ref.attachmentId)
    if (this.published.has(id)) return []
    this.published.add(id)
    return [ref]
  }

  private async externalizeImageGeneration(
    event: Extract<CodexAppServerEvent, { readonly kind: 'notification' }>,
  ): Promise<ExternalizedCodexEvent> {
    const current = object(event.params.item, 'Codex image-generation item', 'MALFORMED_RESPONSE')
    if (current.type !== 'imageGeneration') return { event, images: [] }
    if (typeof current.result !== 'string') {
      throw new LlmError('Codex App Server returned invalid image-generation result', 'MALFORMED_RESPONSE')
    }
    if (current.result.length === 0) {
      if (current.status === 'completed') {
        throw new LlmError('Codex App Server completed image generation without image bytes', 'MALFORMED_RESPONSE')
      }
      return { event, images: [] }
    }
    const store = this.store()
    const input = decodedBase64(
      current.result,
      'image/png',
      store.imageLimits,
      'image-generation base64',
      displayName(current.savedPath),
    )
    const ref = await this.save(input)
    return {
      event: {
        ...event,
        params: {
          ...event.params,
          item: { ...current, result: imageAttachmentMarker(ref) },
        },
      },
      images: this.publish(ref),
    }
  }

  private async externalizeRawItem(
    event: Extract<CodexAppServerEvent, { readonly kind: 'notification' }>,
  ): Promise<ExternalizedCodexEvent> {
    const current = object(event.params.item, 'Codex raw response item', 'MALFORMED_RESPONSE')
    if (current.type === 'function_call_output' && Array.isArray(current.output)) {
      const supplied = typeof current.call_id === 'string' && this.harnessCallIds.has(current.call_id)
      return this.externalizeRawContent(event, current, 'output', supplied)
    }
    if (current.type === 'message' && current.role !== 'assistant' && Array.isArray(current.content)) {
      return this.externalizeRawContent(event, current, 'content', true)
    }
    return { event, images: [] }
  }

  private async externalizeRawContent(
    event: Extract<CodexAppServerEvent, { readonly kind: 'notification' }>,
    current: JsonObject,
    field: 'content' | 'output',
    supplied: boolean,
  ): Promise<ExternalizedCodexEvent> {
    const values = current[field] as unknown[]
    const pending: PendingOutputImage[] = []
    for (const [index, value] of values.entries()) {
      const content = object(value, `Codex ${field} content ${index}`, 'MALFORMED_RESPONSE')
      if (content.type !== 'input_image' || typeof content.image_url !== 'string'
        || !content.image_url.startsWith('data:')) continue
      const input = decodedDataUrl(
        content.image_url,
        this.store().imageLimits,
        `${field} image ${index}`,
      )
      if (input !== undefined) pending.push({ index, input })
    }
    if (pending.length === 0) return { event, images: [] }
    const store = this.store()
    const totalBytes = pending.reduce((total, entry) => total + entry.input.data.byteLength, 0)
    if (pending.length > store.imageLimits.maxImagesPerMessage
      || totalBytes > store.imageLimits.maxMessageImageBytes) {
      throw new LlmError('Codex App Server returned too many image bytes in one content item', 'MALFORMED_RESPONSE')
    }
    await Promise.all(pending
      .filter(entry => !this.references.has(imageKey(entry.input)))
      .map(entry => store.validateImage(entry.input)))
    const output = [...values] as JsonValue[]
    const images: ImageAttachmentRef[] = []
    for (const entry of pending) {
      const ref = await this.save(entry.input)
      const content = object(output[entry.index], `Codex ${field} content ${entry.index}`, 'MALFORMED_RESPONSE')
      output[entry.index] = { ...content, image_url: imageAttachmentMarker(ref) }
      const attachmentId = String(ref.attachmentId)
      if (supplied || this.supplied.has(attachmentId)) this.supplied.add(attachmentId)
      else images.push(...this.publish(ref))
    }
    return {
      event: {
        ...event,
        params: {
          ...event.params,
          item: { ...current, [field]: output },
        },
      },
      images,
    }
  }

  private async hydrateItem(item: JsonValue, label: string, signal?: AbortSignal): Promise<JsonValue> {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    if (item.type === 'message' && Array.isArray(item.content)) {
      const supplied = item.role !== 'assistant'
      const content = await this.hydrateRawContent(item.content, `${label}.content`, supplied, signal)
      return content === item.content ? item : { ...item, content }
    }
    if (item.type === 'function_call_output' && Array.isArray(item.output)) {
      const supplied = typeof item.call_id === 'string' && this.harnessCallIds.has(item.call_id)
      const output = await this.hydrateRawContent(item.output, `${label}.output`, supplied, signal)
      return output === item.output ? item : { ...item, output }
    }
    return item
  }

  private async hydrateRawContent(
    values: readonly JsonValue[],
    label: string,
    supplied: boolean,
    signal?: AbortSignal,
  ): Promise<JsonValue[]> {
    return Promise.all(values.map(async (value, index): Promise<JsonValue> => {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || value.type !== 'input_image') {
        return value
      }
      if (typeof value.image_url === 'string') return value
      const ref = markerReference(value.image_url, `${label}[${index}].image_url`)
      ;(supplied ? this.supplied : this.published).add(String(ref.attachmentId))
      return { ...value, image_url: await this.dataUrl(ref, signal) }
    }))
  }

  private async hydrateToolOutput(output: JsonValue, signal?: AbortSignal): Promise<JsonValue[]> {
    if (!Array.isArray(output)) {
      throw new LlmError('Codex history contains invalid structured tool output', 'INVALID_HISTORY')
    }
    return Promise.all(output.map(async (value, index): Promise<JsonValue> => {
      const item = object(value, `toolResult.output[${index}]`, 'INVALID_HISTORY')
      if (item.type === 'input_text' && typeof item.text === 'string') {
        return { type: 'inputText', text: item.text }
      }
      if (item.type === 'input_image' && typeof item.image_url !== 'string') {
        const ref = markerReference(item.image_url, `toolResult.output[${index}].image_url`)
        this.supplied.add(String(ref.attachmentId))
        return { type: 'inputImage', imageUrl: await this.dataUrl(ref, signal) }
      }
      throw new LlmError(`Codex history contains unsupported toolResult.output[${index}]`, 'INVALID_HISTORY')
    }))
  }

  private dataUrl(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<string> {
    const key = JSON.stringify(referenceValue(ref))
    let task = this.hydrated.get(key)
    if (task === undefined) {
      task = this.store().readImage(ref, signal).then((stored) => {
        if (JSON.stringify(referenceValue(stored.ref)) !== key) {
          throw new LlmError('Codex attachment read returned a mismatched reference', 'INVALID_HISTORY')
        }
        const input = { data: stored.data, mediaType: stored.ref.mediaType }
        this.references.set(imageKey(input), stored.ref)
        return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
      })
      this.hydrated.set(key, task)
    }
    return task
  }
}
