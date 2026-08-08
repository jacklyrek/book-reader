import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { formatBytes } from '../core/storage'
import type { BookRecord, CatalogWork } from '../core/types'

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div class="spinner" role="status" aria-live="polite">
      <div class="spinner-dot" />
      {label ? <span>{label}</span> : null}
    </div>
  )
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string
  body?: string
  action?: ComponentChildren
}): JSX.Element {
  return (
    <div class="empty">
      <h2>{title}</h2>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  )
}

export function ErrorNote({ error }: { error: Error | string }): JSX.Element {
  return (
    <div class="error-note" role="alert">
      {typeof error === 'string' ? error : error.message}
    </div>
  )
}

export function ProgressBar({ value, label }: { value: number; label?: string }): JSX.Element {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div class="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-label={label}>
      <div class="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Cover({
  src,
  title,
  authors,
  size = 'md',
}: {
  src?: string
  title: string
  authors?: string[]
  size?: 'sm' | 'md' | 'lg'
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (src && !failed) {
    return (
      <img
        class={`cover cover-${size}`}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    )
  }
  // A generated cover beats a broken-image icon, and most Gutenberg books
  // don't have real cover art anyway.
  return (
    <div class={`cover cover-${size} cover-fallback`} aria-hidden="true">
      <span class="cover-title">{title}</span>
      {authors?.length ? <span class="cover-author">{authors[0]}</span> : null}
    </div>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ComponentChildren
  tone?: 'neutral' | 'good' | 'warn' | 'audio' | 'text'
}): JSX.Element {
  return <span class={`badge badge-${tone}`}>{children}</span>
}

export function SourceBadges({ work }: { work: CatalogWork | BookRecord }): JSX.Element {
  const editions = 'editions' in work ? work.editions : work.edition ? [work.edition] : []
  const recordings = 'recordings' in work ? work.recordings : work.recording ? [work.recording] : []
  return (
    <div class="badges">
      {editions[0] ? (
        <Badge tone="text">
          {editions[0].source === 'standard-ebooks' ? 'Standard Ebooks' : 'Gutenberg'}
        </Badge>
      ) : null}
      {recordings[0] ? <Badge tone="audio">Audio</Badge> : null}
    </div>
  )
}

export function Bytes({ value }: { value: number }): JSX.Element {
  return <span class="bytes">{formatBytes(value)}</span>
}

/** Bottom sheet. Modal, dismissable by backdrop tap, and safe-area aware. */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ComponentChildren
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div
        class="sheet"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div class="sheet-grabber" />
        {title ? <h2 class="sheet-title">{title}</h2> : null}
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}): JSX.Element {
  return (
    <label class="toggle">
      <span class="toggle-text">
        <span class="toggle-label">{label}</span>
        {hint ? <span class="toggle-hint">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)}
      />
      <span class="toggle-track" aria-hidden="true">
        <span class="toggle-knob" />
      </span>
    </label>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onInput,
  label,
  format,
}: {
  value: number
  min: number
  max: number
  step?: number
  onInput: (value: number) => void
  label: string
  format?: (value: number) => string
}): JSX.Element {
  return (
    <label class="slider">
      <span class="slider-head">
        <span>{label}</span>
        <span class="slider-value">{format ? format(value) : value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(event) => onInput(Number((event.currentTarget as HTMLInputElement).value))}
      />
    </label>
  )
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label?: string
}): JSX.Element {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          class={option.value === value ? 'segment segment-active' : 'segment'}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Bare-bones toast, used for download warnings and sync errors. */
export function Toast({
  message,
  onDismiss,
}: {
  message: string | null
  onDismiss: () => void
}): JSX.Element | null {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [message, onDismiss])

  if (!message) return null
  return (
    <div class="toast" role="status" onClick={onDismiss}>
      {message}
    </div>
  )
}
