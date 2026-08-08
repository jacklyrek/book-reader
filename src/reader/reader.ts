/**
 * EPUB reader (§7.2), wrapping foliate-js.
 *
 * foliate-js is the rendering core from Foliate: modern ESM, actively
 * maintained, paginates with CSS columns. epub.js is better known but has been
 * effectively unmaintained and its iOS pagination is glitchy.
 *
 * Positions are EPUB CFIs, so they survive font-size changes and are portable
 * to other readers — and they're the locator format the annotations export
 * shares with the commonplace book (§10).
 */
import type {
  DrawAnnotationDetail,
  LoadDetail,
  RelocateDetail,
  ShowAnnotationDetail,
  TOCItem,
  View,
} from 'foliate-js/view.js'
import { getKV, setKV } from '../core/db'
import type { AnnotationRecord, Settings } from '../core/types'
import type { SpineEntry } from '../player/handoff'
import { paginatorAttributes, readerCss, THEMES } from './themes'

export interface ReaderLocation {
  cfi?: string
  fraction: number
  /** Spine index — the unit the audio handoff maps against (§7.4). */
  index: number
  label?: string
  pagesLeftInChapter?: number
}

export interface ReaderCallbacks {
  onRelocate?: (location: ReaderLocation) => void
  onSelection?: (selection: { cfi: string; text: string; rect: DOMRect } | null) => void
  onAnnotationClick?: (cfi: string) => void
  onError?: (error: Error) => void
}

/** Cached per book so the player can build a chapter map without opening the EPUB. */
export interface BookOutline {
  bookId: string
  spine: SpineEntry[]
  toc: { label: string; href: string; depth: number }[]
  cachedAt: number
}

const OUTLINE_KEY = 'readerOutlines'

export class Reader {
  view: View | null = null
  private container: HTMLElement | null = null
  private callbacks: ReaderCallbacks = {}
  private currentSettings: Settings | null = null
  private annotationColors = new Map<string, string>()
  private documents = new Map<number, Document>()
  private currentIndex = 0

  async open(
    container: HTMLElement,
    file: Blob,
    options: {
      bookId: string
      lastLocation?: string | null
      settings: Settings
      callbacks?: ReaderCallbacks
    },
  ): Promise<void> {
    this.container = container
    this.callbacks = options.callbacks ?? {}
    this.currentSettings = options.settings

    // Registers <foliate-view>. Dynamic so the reader chunk isn't in the
    // initial bundle — the library screen doesn't need it.
    await import('foliate-js/view.js')

    const view = document.createElement('foliate-view') as View
    this.view = view
    container.append(view)

    view.addEventListener('relocate', (event) => {
      this.onRelocate((event as CustomEvent<RelocateDetail>).detail)
    })
    view.addEventListener('load', (event) => {
      this.onLoad((event as CustomEvent<LoadDetail>).detail)
    })
    view.addEventListener('draw-annotation', (event) => {
      void this.onDrawAnnotation((event as CustomEvent<DrawAnnotationDetail>).detail)
    })
    view.addEventListener('show-annotation', (event) => {
      const detail = (event as CustomEvent<ShowAnnotationDetail>).detail
      this.callbacks.onAnnotationClick?.(detail.value)
    })
    view.addEventListener('external-link', (event) => {
      // Let the browser handle it, but don't navigate the app away.
      event.preventDefault()
    })

    // foliate's makeBook sniffs `file.name`, so a bare Blob throws.
    const named =
      file instanceof File
        ? file
        : new File([file], `${options.bookId}.epub`, { type: 'application/epub+zip' })

    try {
      await view.open(named)
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }

    this.applySettings(options.settings)
    await view.init({ lastLocation: options.lastLocation ?? null, showTextStart: true })
    await this.cacheOutline(options.bookId)
  }

  close(): void {
    this.view?.close()
    this.view?.remove()
    this.view = null
    this.documents.clear()
    this.container = null
  }

  // --- typography ----------------------------------------------------------

  applySettings(settings: Settings): void {
    this.currentSettings = settings
    const view = this.view
    if (!view?.renderer) return

    for (const [key, value] of Object.entries(paginatorAttributes(settings))) {
      view.renderer.setAttribute(key, value)
    }
    view.renderer.setStyles(readerCss(settings))

    // The chrome around the page follows the page, or the seam shows.
    const palette = THEMES[settings.theme]
    this.container?.style.setProperty('--reader-bg', palette.bg)
    this.container?.style.setProperty('--reader-fg', palette.fg)
    this.container?.style.setProperty('--reader-chrome', palette.chrome)
  }

  // --- navigation ----------------------------------------------------------

  next(): void {
    void this.view?.next()
  }

  prev(): void {
    void this.view?.prev()
  }

  goLeft(): void {
    void this.view?.goLeft()
  }

  goRight(): void {
    void this.view?.goRight()
  }

  async goTo(target: string | number): Promise<void> {
    await this.view?.goTo(target)
  }

  async goToFraction(fraction: number): Promise<void> {
    await this.view?.goToFraction(fraction)
  }

  /** Used by the listen→read handoff: jump to the top of a spine section. */
  async goToSpineIndex(index: number): Promise<void> {
    await this.view?.goTo(index)
  }

  get toc(): TOCItem[] {
    return this.view?.book.toc ?? []
  }

  get spine(): SpineEntry[] {
    return this.buildSpine()
  }

  // --- annotations ---------------------------------------------------------

  /** Draw the stored highlights for a book once its sections load. */
  async applyAnnotations(annotations: AnnotationRecord[]): Promise<void> {
    const view = this.view
    if (!view) return
    for (const annotation of annotations) {
      if (annotation.kind === 'bookmark') continue
      this.annotationColors.set(annotation.locator, annotation.color)
      try {
        await view.addAnnotation({ value: annotation.locator })
      } catch (error) {
        // A CFI from another edition of the same book won't resolve. Skip it
        // rather than failing the whole render.
        console.warn('[reader] could not place annotation', annotation.locator, error)
      }
    }
  }

  async addAnnotation(annotation: AnnotationRecord): Promise<void> {
    this.annotationColors.set(annotation.locator, annotation.color)
    await this.view?.addAnnotation({ value: annotation.locator })
  }

  async removeAnnotation(locator: string): Promise<void> {
    this.annotationColors.delete(locator)
    await this.view?.deleteAnnotation({ value: locator })
  }

  private async onDrawAnnotation(detail: DrawAnnotationDetail): Promise<void> {
    const { Overlayer } = await import('foliate-js/overlayer.js')
    const color = this.annotationColors.get(detail.annotation.value) ?? '#c9a227'
    detail.draw(Overlayer.highlight, { color })
  }

  /** The current selection as a CFI, or null when nothing is selected. */
  currentSelection(): { cfi: string; text: string; rect: DOMRect } | null {
    const view = this.view
    const doc = this.documents.get(this.currentIndex)
    if (!view || !doc) return null

    const selection = doc.defaultView?.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

    const range = selection.getRangeAt(0)
    const text = range.toString().trim()
    if (!text) return null

    return {
      cfi: view.getCFI(this.currentIndex, range),
      text,
      rect: range.getBoundingClientRect(),
    }
  }

  clearSelection(): void {
    this.view?.deselect()
  }

  // --- search --------------------------------------------------------------

  async *search(query: string): AsyncGenerator<{
    label: string
    cfi: string
    excerpt: string
  }> {
    const view = this.view
    if (!view) return
    for await (const result of view.search({ query })) {
      if (result === 'done') return
      if (!result.subitems) continue
      for (const item of result.subitems) {
        yield {
          label: result.label ?? '',
          cfi: item.cfi,
          excerpt: `${item.excerpt.pre}${item.excerpt.match}${item.excerpt.post}`,
        }
      }
    }
  }

  clearSearch(): void {
    this.view?.clearSearch()
  }

  // --- internals -----------------------------------------------------------

  private onLoad(detail: LoadDetail): void {
    this.documents.set(detail.index, detail.doc)
    this.currentIndex = detail.index

    // Tap zones: left third goes back, right third forward, middle toggles the
    // chrome. Handled here because the section document is in an iframe.
    detail.doc.addEventListener('selectionchange', () => {
      this.callbacks.onSelection?.(this.currentSelection())
    })
  }

  private onRelocate(detail: RelocateDetail): void {
    if (detail.range === undefined && detail.cfi === undefined) return
    this.callbacks.onRelocate?.({
      cfi: detail.cfi,
      fraction: detail.fraction ?? 0,
      index: detail.section?.current ?? this.currentIndex,
      label: detail.tocItem?.label,
      pagesLeftInChapter:
        detail.location && detail.location.total
          ? Math.max(0, detail.location.total - detail.location.current)
          : undefined,
    })
  }

  private buildSpine(): SpineEntry[] {
    const view = this.view
    if (!view) return []
    const labels = new Map<number, string>()

    const walk = (items: TOCItem[]): void => {
      for (const item of items) {
        const resolved = view.book.resolveHref?.(item.href)
        if (resolved && !labels.has(resolved.index)) labels.set(resolved.index, item.label)
        if (item.subitems) walk(item.subitems)
      }
    }
    try {
      walk(view.book.toc ?? [])
    } catch {
      // resolveHref throws on malformed TOC hrefs, which Gutenberg produces.
    }

    return view.book.sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.linear !== 'no')
      .map(({ index }) => ({ index, label: labels.get(index) }))
  }

  /**
   * Persist the spine/TOC so the player can build a chapter map without
   * unzipping the EPUB, and so the reader's chapter list renders instantly on
   * reopen (§7.2 — recomputing on every open is the main source of jank).
   */
  private async cacheOutline(bookId: string): Promise<void> {
    const view = this.view
    if (!view) return

    const toc: BookOutline['toc'] = []
    const walk = (items: TOCItem[], depth: number): void => {
      for (const item of items) {
        toc.push({ label: item.label, href: item.href, depth })
        if (item.subitems) walk(item.subitems, depth + 1)
      }
    }
    walk(view.book.toc ?? [], 0)

    const outline: BookOutline = {
      bookId,
      spine: this.buildSpine(),
      toc,
      cachedAt: Date.now(),
    }

    const all = (await getKV<Record<string, BookOutline>>(OUTLINE_KEY)) ?? {}
    all[bookId] = outline
    await setKV(OUTLINE_KEY, all)
  }
}

export async function cachedOutline(bookId: string): Promise<BookOutline | undefined> {
  const all = (await getKV<Record<string, BookOutline>>(OUTLINE_KEY)) ?? {}
  return all[bookId]
}
