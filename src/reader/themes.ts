/**
 * Reader typography and themes (§7.2).
 *
 * The goal in the design is text that doesn't feel like a web page: real
 * measure, real leading, hyphenation, and page transitions that respect
 * `prefers-reduced-motion`.
 */
import type { ReaderTheme, Settings } from '../core/types'

export interface ThemePalette {
  name: string
  bg: string
  fg: string
  link: string
  /** Selection and highlight tint. */
  accent: string
  /** For the app chrome around the page, not the page itself. */
  chrome: string
}

export const THEMES: Record<ReaderTheme, ThemePalette> = {
  paper: {
    name: 'Paper',
    bg: '#faf7f2',
    fg: '#1b1917',
    link: '#8a4b2a',
    accent: '#c9a227',
    chrome: '#efe9e0',
  },
  sepia: {
    name: 'Sepia',
    bg: '#f2e5cf',
    fg: '#3b2f24',
    link: '#7a4419',
    accent: '#b07d3a',
    chrome: '#e6d5b8',
  },
  night: {
    name: 'Night',
    bg: '#1c1b1a',
    fg: '#ddd6cc',
    link: '#d0a06a',
    accent: '#8a6d3b',
    chrome: '#131211',
  },
  black: {
    // For OLED, and for reading in a dark room without lighting the ceiling.
    name: 'Black',
    bg: '#000000',
    fg: '#b9b3aa',
    link: '#c08b4f',
    accent: '#6d552a',
    chrome: '#000000',
  },
}

export const FONT_STACKS: { label: string; value: string }[] = [
  { label: 'Literata', value: 'Literata, Georgia, "Times New Roman", serif' },
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Palatino', value: '"Palatino Linotype", Palatino, Georgia, serif' },
  { label: 'Iowan', value: '"Iowan Old Style", Georgia, serif' },
  { label: 'System sans', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: 'Charter', value: 'Charter, Georgia, serif' },
]

/**
 * CSS injected into each section document. Everything is `!important` because
 * publisher stylesheets — especially Gutenberg's — are opinionated and will
 * otherwise win.
 */
export function readerCss(settings: Settings): string {
  const palette = THEMES[settings.theme]
  return `
    @namespace epub "http://www.idpf.org/2007/ops";

    :root {
      color-scheme: ${settings.theme === 'paper' || settings.theme === 'sepia' ? 'light' : 'dark'};
      --pdr-fg: ${palette.fg};
      --pdr-bg: ${palette.bg};
      --pdr-accent: ${palette.accent};
      --overlayer-highlight-opacity: 0.32;
    }

    html, body {
      background: ${palette.bg} !important;
      color: ${palette.fg} !important;
      font-family: ${settings.fontFamily} !important;
      font-size: ${settings.fontSize}px !important;
      line-height: ${settings.lineHeight} !important;
      /* Safari inflates text in multi-column layouts without this. */
      -webkit-text-size-adjust: none !important;
      text-size-adjust: none !important;
    }

    body {
      margin: 0 !important;
      padding: 0 !important;
      widows: 2;
      orphans: 2;
      hanging-punctuation: allow-end last;
    }

    p, li, blockquote, dd {
      font-family: inherit !important;
      font-size: inherit !important;
      line-height: inherit !important;
      text-align: ${settings.justify ? 'justify' : 'start'} !important;
      -webkit-hyphens: ${settings.hyphenate ? 'auto' : 'manual'} !important;
      hyphens: ${settings.hyphenate ? 'auto' : 'manual'} !important;
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 3;
      hyphenate-limit-chars: 6 3 3;
    }

    /* Publisher indents are wildly inconsistent; normalise to one convention. */
    p { margin: 0 !important; text-indent: 1.2em; }
    p:first-of-type, h1 + p, h2 + p, h3 + p, hr + p,
    p.first, p.no-indent, blockquote p:first-child { text-indent: 0; }

    h1, h2, h3, h4, h5, h6 {
      font-family: inherit !important;
      color: ${palette.fg} !important;
      line-height: 1.25 !important;
      text-align: start !important;
      -webkit-hyphens: none !important;
      hyphens: none !important;
      break-after: avoid;
      margin: 1.6em 0 0.8em !important;
    }
    h1 { font-size: 1.5em !important; }
    h2 { font-size: 1.3em !important; }
    h3 { font-size: 1.12em !important; }

    a, a:visited { color: ${palette.link} !important; text-decoration: none !important; }
    a:hover { text-decoration: underline !important; }

    /* Keep figures inside the column box; overflow breaks pagination. */
    img, svg, video {
      max-width: 100% !important;
      max-height: 85vh !important;
      height: auto !important;
      object-fit: contain;
      break-inside: avoid;
    }

    blockquote {
      margin: 1em 1.4em !important;
      font-style: italic;
    }

    table { max-width: 100% !important; font-size: 0.9em !important; }
    pre, code { font-size: 0.85em !important; white-space: pre-wrap !important; }

    ::selection { background: ${palette.accent}66; }

    /* iOS scroll-snap is smoother than a JS-animated slide (§7.2). */
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
  `
}

/**
 * Attributes on the paginator element. `max-inline-size` is the measure: past
 * ~40em a line is tiring to read, and on an iPhone in landscape two columns
 * beat one very wide one.
 *
 * It must be given in px. foliate reads the attribute back with `parseFloat`,
 * so a unit it doesn't understand is silently dropped — `40em` becomes 40, and
 * in scrolled flow that number is used as the body width verbatim, leaving a
 * 40px column. So resolve the em against the reader's own font size here.
 */
export function paginatorAttributes(settings: Settings): Record<string, string> {
  return {
    flow: settings.flow,
    gap: '6%',
    margin: `${settings.margin}px`,
    'max-inline-size': `${Math.round(settings.fontSize * 40)}px`,
    'max-block-size': '100%',
    'max-column-count': settings.flow === 'paginated' ? '2' : '1',
  }
}
