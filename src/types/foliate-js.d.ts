/**
 * foliate-js ships as plain ESM with no type declarations. These cover the
 * surface the reader actually uses (§7.2).
 */
declare module 'foliate-js/view.js' {
  export interface TOCItem {
    id?: number | string
    label: string
    href: string
    subitems?: TOCItem[]
  }

  export interface BookSection {
    id: string
    linear?: string
    cfi?: string
    size?: number
    createDocument?: () => Promise<Document>
    mediaOverlay?: unknown
  }

  export interface BookMetadata {
    title?: string | { [key: string]: string }
    author?: string | { name?: string }[]
    language?: string | string[]
    description?: string
    publisher?: string
  }

  export interface Book {
    metadata?: BookMetadata
    sections: BookSection[]
    toc?: TOCItem[]
    pageList?: TOCItem[]
    dir?: string
    rendition?: { layout?: string }
    getCover?: () => Promise<Blob | null>
    resolveHref?: (href: string) => { index: number; anchor?: unknown }
    splitTOCHref?: (href: string) => unknown
    getTOCFragment?: (doc: Document, id: string) => Node
  }

  export interface RelocateDetail {
    cfi?: string
    fraction?: number
    location?: { current: number; next: number; total: number }
    tocItem?: TOCItem
    pageItem?: TOCItem
    range?: Range
    section?: { current: number; total: number }
  }

  export interface LoadDetail {
    doc: Document
    index: number
  }

  export interface DrawAnnotationDetail {
    draw: (func: unknown, options?: Record<string, unknown>) => void
    annotation: { value: string; [key: string]: unknown }
    doc: Document
    range: Range
  }

  export interface ShowAnnotationDetail {
    value: string
    index: number
    range: Range
  }

  export interface SearchResult {
    label?: string
    subitems?: { cfi: string; excerpt: { pre: string; match: string; post: string } }[]
    progress?: number
    cfi?: string
    excerpt?: { pre: string; match: string; post: string }
  }

  export interface Renderer extends HTMLElement {
    setStyles(styles: string | [string, string]): void
    getContents(): { index: number; doc: Document; overlayer?: unknown }[]
    next(distance?: number): Promise<void>
    prev(distance?: number): Promise<void>
    scrollToAnchor(target: Range | Element, select?: boolean): void
    destroy(): void
  }

  export class View extends HTMLElement {
    book: Book
    renderer: Renderer
    isFixedLayout: boolean
    lastLocation: RelocateDetail | null
    language: { canonical?: string; direction?: string; isCJK?: boolean }

    open(book: Blob | File | string | Book): Promise<void>
    close(): void
    init(options: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>
    goTo(target: string | number): Promise<{ index: number } | undefined>
    goToFraction(fraction: number): Promise<void>
    goToTextStart(): Promise<unknown>
    next(distance?: number): Promise<void>
    prev(distance?: number): Promise<void>
    goLeft(): Promise<void>
    goRight(): Promise<void>
    select(target: string): Promise<void>
    deselect(): void
    getCFI(index: number, range?: Range): string
    resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => Range }
    resolveNavigation(target: string | number): { index: number; anchor?: unknown }
    getSectionFractions(): number[]
    getTOCItemOf(target: string | number): Promise<TOCItem | undefined>
    addAnnotation(
      annotation: { value: string; [key: string]: unknown },
      remove?: boolean,
    ): Promise<{ index: number; label: string } | undefined>
    deleteAnnotation(annotation: { value: string }): Promise<unknown>
    showAnnotation(annotation: { value: string }): Promise<void>
    search(options: { query: string; index?: number }): AsyncGenerator<SearchResult | 'done'>
    clearSearch(): void
  }

  export function makeBook(file: Blob | File | string): Promise<Book>
  export class ResponseError extends Error {}
  export class NotFoundError extends Error {}
  export class UnsupportedTypeError extends Error {}
}

declare module 'foliate-js/overlayer.js' {
  export class Overlayer {
    static highlight(rects: DOMRect[], options?: { color?: string; padding?: number }): SVGElement
    static underline(rects: DOMRect[], options?: { color?: string }): SVGElement
    static squiggly(rects: DOMRect[], options?: { color?: string }): SVGElement
    static strikethrough(rects: DOMRect[], options?: { color?: string }): SVGElement
    static outline(rects: DOMRect[], options?: { color?: string }): SVGElement
    constructor(doc: Document)
    add(value: string, range: Range, func: unknown, options?: Record<string, unknown>): void
    remove(value: string): void
    hitTest(event: Event): [string | undefined, Range | undefined]
  }
}

declare module 'foliate-js/epubcfi.js' {
  export function compare(a: string, b: string): number
  export function parse(cfi: string): unknown
  export function collapse(cfi: string, toEnd?: boolean): string
  export const isCFI: RegExp
}
