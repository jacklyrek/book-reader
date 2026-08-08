# Public Domain Reader — Design Doc

**Status:** Draft v0.1 — written before feature selection. Section 3 is the invariant core; Section 9 flags what changes depending on which optional features you pick.

---

## 1. Goals

- Search a unified catalog of public domain books (text + audio) from an iPhone.
- Download books for genuinely offline reading and listening — no signal required on a plane or in a basement.
- Read EPUBs with typography that doesn't feel like a web page.
- Listen to LibriVox recordings with lock-screen controls and background playback.
- Sync reading/listening position and annotations across devices.

## 2. Non-goals (v1)

- Any non-public-domain content, DRM, or library lending (no Libby/OverDrive integration).
- A social layer — reviews, sharing, follows.
- Android/desktop parity. Design for iOS Safari; anything else working is a bonus.
- Word-level read-along sync (see §7.4 for why this is hard).

---

## 3. Constraints

These are the design drivers. Everything downstream falls out of them.

### 3.1 iOS PWA constraints

| Constraint | Impact | Confidence |
|---|---|---|
| Storage quota is origin-scoped and finite | A single LibriVox audiobook is 100–400 MB. Storage management is a first-class feature, not a settings-page afterthought. | High |
| Storage eviction for unused origins | Installed home-screen web apps are exempt from the 7-day script-writable-storage cap, but call `navigator.storage.persist()` anyway. | Medium — verify |
| Background audio when screen is locked | Historically the #1 killer of PWA audiobook apps. Recent iOS handles it for installed web apps, but this is **spike #1**. | Medium — verify |
| Media Session API | Needed for lock screen artwork, scrub bar, skip buttons. Supported, but `setPositionState` behavior varies. | Medium |
| No File System Access API | All persistence goes through IndexedDB blobs. No "save to Files" without a share-sheet download hack. | High |
| Timers throttled when backgrounded | Sleep timer must not use `setTimeout`. See §7.3. | High |
| Autoplay restrictions | First playback needs a user gesture; keep one long-lived `<audio>` element rather than creating new ones per track. | High |
| Screen Time web filters | Your own domain needs allowlisting, same as the commonplace book app. Use the same domain or a subdomain to avoid re-doing this. | High |

### 3.2 CORS

Most public domain sources were not built for browser fetching. `gutenberg.org` does not reliably send `Access-Control-Allow-Origin`, and the LibriVox API doesn't either. `archive.org` download endpoints generally do. This forces a proxy (§6.1).

---

## 4. Content sources

| Source | What it gives | API | CORS | Notes |
|---|---|---|---|---|
| **Standard Ebooks** | ~1,000 meticulously typeset EPUBs | OPDS feed | Partial | Best reading experience by a wide margin. Make these the default when an edition exists. |
| **Project Gutenberg** | ~75,000 books, EPUB/HTML/TXT | Gutendex (`gutendex.com`) or the official RDF catalog dump | Gutendex yes, files no | The breadth tier. Quality varies from excellent to raw OCR. |
| **LibriVox** | ~20,000 volunteer audiobooks | `librivox.org/api/feed/audiobooks` | No | Metadata via proxy; MP3 files live on archive.org and fetch directly. Narration quality is wildly variable — surface the reader's name and let yourself blacklist narrators. |
| **Internet Archive** | Everything else, plus hosts LibriVox audio | Scrape/Advanced Search API | Mostly yes | Fallback and audio CDN. |
| **Open Library** | Cover art, canonical work IDs | REST | Yes | Useful for deduping editions and prettier shelves. |

**Recommendation:** don't query these live per search. Build your own catalog index (§6.2).

---

## 5. Architecture

```
┌─────────────────────────────────────────────────┐
│  iPhone — installed PWA                          │
│                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │  Reader    │  │  Player    │  │  Library   │ │
│  │ foliate-js │  │ <audio> +  │  │  + Search  │ │
│  │            │  │ MediaSess. │  │            │ │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘ │
│        │               │               │        │
│  ┌─────┴───────────────┴───────────────┴──────┐ │
│  │  App core: state, download queue, sync      │ │
│  └─────┬───────────────────────────────┬───────┘ │
│        │                               │         │
│  ┌─────┴──────┐              ┌─────────┴───────┐ │
│  │ IndexedDB  │              │ Service Worker  │ │
│  │ blobs+meta │◄─────────────┤ shell cache +   │ │
│  └────────────┘   range req  │ media range svr │ │
│                              └─────────┬───────┘ │
└────────────────────────────────────────┼─────────┘
                                         │
                    ┌────────────────────┼──────────────┐
                    │                    │              │
            ┌───────┴───────┐   ┌────────┴──────┐  ┌────┴──────┐
            │ Supabase      │   │ CF Worker     │  │ archive.org│
            │ catalog +sync │   │ CORS proxy    │  │ (direct)   │
            └───────────────┘   └───────────────┘  └────────────┘
```

**Stack:** Vite + TypeScript, no framework or something small (Preact/Svelte) — the reader and player are the app, and a heavy framework buys little. IndexedDB via `idb`. Supabase for catalog + sync, same as the commonplace book. Cloudflare Workers for the proxy.

---

## 6. Backend

### 6.1 CORS proxy (Cloudflare Worker)

- Route: `/p/{source}/{encoded-url}`.
- Allowlist target hosts (gutenberg.org, librivox.org, standardebooks.org). Never a general open proxy.
- Restrict `Origin` to your domain; optionally HMAC-sign URLs generated by the app.
- Use the Cache API aggressively — Gutenberg EPUBs are immutable.
- Stream responses through; pass `Range` headers upstream and back.

### 6.2 Catalog index (Supabase Postgres)

Rather than hitting three APIs live from the phone:

- Nightly job ingests the Gutenberg catalog dump, the Standard Ebooks OPDS feed, and the paginated LibriVox API.
- Tables: `works` (canonical title/author), `editions` (per-source text), `recordings` (per-source audio), `edition_links`.
- Matching text↔audio: normalize title + author (strip subtitles, "The/A", diacritics, translator names), then fuzzy match with `pg_trgm`. Store a `match_confidence` and a manual `overrides` table, because this will be wrong maybe 10% of the time.
- Full-text search with `tsvector`. 75k rows is nothing; search will feel instant.
- Payoff: one fast query per search, offline-cacheable catalog slices, and you control the ranking (Standard Ebooks first).

### 6.3 Sync

- Tables: `progress`, `annotations`, `library_items`, all with `updated_at` and `device_id`.
- Last-write-wins on `updated_at`. You're one user on two devices; CRDTs are overkill.
- Exception worth considering: for `progress`, prefer the *furthest* position over the most recent when timestamps are within a few minutes, to avoid a stale tab rewinding you.
- Queue mutations locally in an `outbox` store; drain on reconnect. Never block the UI on network.

---

## 7. Client subsystems

### 7.1 Storage / data model (IndexedDB)

| Store | Key | Contents |
|---|---|---|
| `books` | `bookId` | title, authors, sources, language, subjects, addedAt, coverKey |
| `assets` | `assetId` | `{bookId, kind: 'epub'\|'audio'\|'cover', trackIndex, blob, bytes, mime, etag}` |
| `progress` | `bookId` | `{locator, percent, trackIndex, positionSec, updatedAt}` |
| `annotations` | `id` | `{bookId, locator, kind, color, note, createdAt}` |
| `downloads` | `jobId` | queue state, retry count, bytes done |
| `outbox` | `id` | pending sync mutations |

Storage rules:
- Show a real storage dashboard (per-book bytes, sortable, swipe to delete).
- Offer audio bitrate choice at download time (LibriVox usually has 64kbps and 128kbps).
- Optional auto-eviction: delete audio for books finished >30 days ago, keeping progress and annotations.
- Check `navigator.storage.estimate()` before every download and warn at 80%.

### 7.2 EPUB reader

**Engine: `foliate-js`.** It's the rendering core from Foliate — modern ESM, actively maintained, handles EPUB/CBZ/FB2, and paginates via CSS columns. `epub.js` is the better-known option but has been effectively unmaintained and its iOS pagination is glitchy. Fallback plan: if foliate-js fights you on iOS, drop to your own renderer — `@zip.js/zip.js` to unzip, parse the OPF manifest/spine, inject each XHTML doc into an iframe with your own stylesheet and CSS multi-column pagination. That's a week of work, not a month.

Locators: use EPUB CFI so positions survive font-size changes and are portable to other readers.

Non-obvious details:
- Sanitize/rewrite internal resource URLs to blob URLs before injecting, or images won't load offline.
- Cache computed pagination per (book, font-size, width) — recomputing on every open is the main source of reader jank.
- Respect `prefers-reduced-motion` for page transitions; iOS scroll-snap is smoother than JS-animated slides.

### 7.3 Audio player

This is where most of the fiddly iOS work lives.

**Serving offline audio.** Do *not* set `audio.src` to a `blob:` URL. Blob URLs hold the whole file in memory and behave badly with seeking. Instead:

1. Register a service worker with app-wide scope.
2. Set `audio.src = '/media/{assetId}'`.
3. The SW intercepts that path, reads the `Range` header, pulls the blob from IndexedDB, and returns `206 Partial Content` with `Content-Range`, `Accept-Ranges: bytes`, and a correct `Content-Length` from `blob.slice(start, end + 1)`.

This gives you instant seeking, low memory, and identical code paths for streamed and downloaded audio.

**Element lifecycle.** Create exactly one `<audio>` element at app boot and never replace it. Advance tracks by setting `.src` on that element inside the `ended` handler. Creating a new element while backgrounded loses the audio session and playback dies silently.

**Media Session.** Set `metadata` (title, author, cover artwork), and handlers for `play`, `pause`, `seekbackward`, `seekforward`, `previoustrack`, `nexttrack`. Call `setPositionState` on `timeupdate` (throttled to ~1/sec) so the lock-screen scrubber tracks correctly. Map skip buttons to ±30s/±15s rather than track changes — more useful for a 12-hour book.

**Sleep timer.** Compute an absolute `endsAt` timestamp and check it inside the `timeupdate` handler, which keeps firing during background playback. Timers based on `setTimeout` get throttled and will overshoot by minutes. Add an "end of chapter" mode and a 20-second fade-out.

**Playback speed.** `playbackRate` up to 2.0 with `preservesPitch = true`. Persist per book.

### 7.4 Read-along sync (be realistic here)

Three tiers, increasing in cost:

1. **Chapter-level (v1).** Map EPUB spine items to LibriVox tracks — usually 1:1, since LibriVox sections follow chapters. Switching from reading to listening drops you at the top of the current chapter. Cheap, works, good enough 90% of the time.
2. **Media Overlays.** EPUB 3 has a real standard for this (SMIL). Almost no public domain book ships with it. Support it if present; don't count on it.
3. **Forced alignment.** Run Whisper (with word timestamps) or `aeneas` over the audio against the chapter text to produce a timing map. This has to happen server-side as a batch job, takes real compute per book, and you'd cache the resulting alignment files in Supabase. Genuinely great when it works. Absolutely not v1.

### 7.5 Download pipeline

- Job queue in IndexedDB, one active download at a time (iOS gets unhappy with many concurrent large fetches).
- Fetch with `ReadableStream` so you can show real byte progress and resume via `Range` on failure.
- Verify `Content-Length` matches bytes written before marking complete; partial EPUBs that fail to open are the worst failure mode.
- Audiobooks are many files — treat "download book" as a parent job with per-track children, and let it resume mid-book.
- Warn before starting a >200 MB download on cellular (`navigator.connection.effectiveType` is unavailable on iOS Safari, so this may have to be a manual setting).

---

## 8. Risk register — do these spikes first

| # | Risk | Spike (half a day each) |
|---|---|---|
| 1 | Background audio dies when the phone locks | Bare-bones PWA: one audio element, one MP3, Media Session. Install to home screen. Lock phone. Does it keep playing for 10 minutes? Does the lock screen show controls? **If this fails, the audio half of the project fails and you should reconsider a native wrapper.** |
| 2 | Storage quota too small for audiobooks | Write 500 MB of blobs to IndexedDB in a chunked loop. Check `estimate()`. Reboot phone, verify still there. |
| 3 | foliate-js on iOS Safari | Render a Standard Ebooks EPUB, paginate, change font size, verify CFI round-trips. |
| 4 | SW range serving | Serve a 100 MB MP3 from IndexedDB via SW; verify seeking to 90% is instant. |
| 5 | Screen Time blocks the domain | Deploy a hello-world page to your intended domain and confirm it loads under your existing restrictions. |

Nothing else is worth building until 1, 2, and 4 pass.

---

## 9. Milestones

- **M0 — Spikes.** The five above. Go/no-go on background audio.
- **M1 — Read online.** Catalog ingest + search, book detail page, open an EPUB from Standard Ebooks/Gutenberg, basic reader with themes.
- **M2 — Read offline.** Download queue, IndexedDB assets, offline shell, progress persistence, storage dashboard.
- **M3 — Listen.** LibriVox streaming, then offline audio via SW range serving, Media Session, sleep timer, speed control.
- **M4 — Sync + annotations.** Supabase sync, highlights/notes/bookmarks, export.
- **M5 — Polish.** Chapter-level read↔listen handoff, collections, better typography controls, search-in-book.

---

## 10. Open questions (pending your feature picks)

- **Annotations:** if you want highlights exportable to the commonplace book app, the two should share a locator format and possibly a Supabase project. Worth deciding now, not later — it affects the schema.
- **Great Books integration:** if the app should track your Britannica GBWW canon progress, that's a `collections` table plus a curated seed list, and it changes the library UI from "recently added" to "shelf-oriented."
- **Multi-device:** is this iPhone-only, or does the Mac matter? Mac Safari support is free-ish but constrains layout decisions.
- **Auth:** Supabase magic link, or a single hardcoded user with a long-lived token? The latter is meaningfully simpler if it's only ever you.
