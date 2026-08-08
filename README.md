# Public Domain Reader

An offline-first PWA for reading and listening to public domain books on an
iPhone. Implements [`public-domain-reader-design.md`](public-domain-reader-design.md);
section references below point back at it.

- Search a unified catalog of Standard Ebooks, Project Gutenberg and LibriVox.
- Download books and audiobooks for genuinely offline use.
- Read EPUBs with typography that isn't a web page.
- Listen with lock-screen controls, background playback and a sleep timer that
  doesn't overshoot.
- Sync position and annotations across devices.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173, also served on the LAN for the phone
npm test             # 47 unit + integration tests
npm run build        # type-check, then bundle to dist/
```

With no configuration the app runs **local-only**: it queries the public APIs
directly, keeps everything on-device, and skips sync. Two things are worth
setting up when you're ready — see [Configuration](#configuration).

> **Node isn't installed on this machine.** The toolchain was fetched into a
> scratch directory to build and test this. Install Node 20+ (`brew install
> node`) before running the commands above.

## Do the spikes first

The design's risk register (§8) says nothing else is worth building until risks
1, 2 and 4 pass. Standalone harnesses for all five live in
[`public/spikes/`](public/spikes/) and are served at `/spikes/` by both the dev
server and the built app.

| # | Spike | Gate |
|---|---|---|
| 1 | [Background audio](public/spikes/1-background-audio.html) | Installed to home screen, does audio survive 10 minutes with the phone locked? Do lock-screen controls work? **If this fails, the audio half of the project fails.** |
| 2 | [Storage quota](public/spikes/2-storage-quota.html) | Does 500 MB write to IndexedDB, and survive a reboot? |
| 3 | [foliate-js on iOS](public/spikes/3-foliate.html) | Does pagination hold up, and do CFIs round-trip across a font-size change? |
| 4 | [SW range serving](public/spikes/4-sw-range.html) | 206 responses with correct byte counts, and instant seeking to 90%. |
| 5 | [Screen Time](public/spikes/5-screen-time.html) | Does the domain load under your existing restrictions? |

Run them on the actual phone, installed to the home screen — a browser tab gets
a smaller storage allowance and behaves differently in the background.

## Layout

```
src/
  core/        data model, IndexedDB, downloads, storage, sync, progress, router
  catalog/     source adapters (Gutendex, LibriVox, Standard Ebooks) + Supabase
  reader/      foliate-js wrapper, themes, annotations
  player/      audio element, Media Session, sleep timer, read↔listen handoff
  ui/          screens
  sw.ts        service worker: app shell + /media/{assetId} range server
worker/        Cloudflare Worker CORS proxy
supabase/      SQL migrations + nightly ingest job
public/spikes/ risk-register harnesses
tests/         unit + IndexedDB integration + boot smoke test
```

## How the load-bearing parts work

**Offline audio never touches a `blob:` URL** (§7.3). `audio.src` is
`/media/{assetId}`; the service worker intercepts it, reads the `Range` header,
pulls the blob out of IndexedDB and answers `206 Partial Content` from
`blob.slice(start, end + 1)`. Seeking is instant, memory stays flat, and
streamed and downloaded audio take the same code path. `src/sw.ts` imports
nothing the app imports, so it builds to a single self-contained `sw.js`.

**One `<audio>` element, created at boot, never replaced** (§7.3). Track changes
set `.src` on that element inside the `ended` handler. Creating a new element
while backgrounded loses the audio session and playback dies silently.

**The sleep timer is an absolute timestamp checked in `timeupdate`** (§7.3), not
a `setTimeout` — background timers get throttled and overshoot by minutes.
`timeupdate` keeps firing during background playback.

**Downloads stream, resume and verify** (§7.5). One transfer at a time; partial
bytes are persisted so a retry resumes with `Range` instead of restarting a
300 MB audiobook; and the byte count is checked against `Content-Length` before
an asset is marked complete, because a truncated EPUB that looks downloaded is
the worst failure mode.

**Progress conflicts prefer the furthest position** (§6.3). Last-write-wins,
except that writes within five minutes of each other resolve to whoever is
further into the book — otherwise a stale tab syncing late rewinds you.

**Read↔listen handoff is chapter-level** (§7.4 tier 1). Spine items map to
LibriVox sections 1:1 where the counts match, by fuzzy title match where they
don't, and proportionally as a last resort. The UI tells you which happened,
because the third case is a guess. Forced alignment is explicitly not v1.

## Configuration

Copy `.env.example` to `.env`. Everything is optional.

### CORS proxy (§6.1) — needed for Gutenberg and LibriVox

Neither sends `Access-Control-Allow-Origin`. archive.org does, so audio files —
the big ones — are fetched directly and never cross the proxy.

```bash
cd worker
npm install
# edit wrangler.toml: set ALLOWED_ORIGINS to your app's origin
npx wrangler secret put PROXY_HMAC_KEY     # must match VITE_PROXY_HMAC_KEY
npx wrangler secret put SE_OPDS_EMAIL      # optional, see below
npm run deploy
```

Then set `VITE_PROXY_BASE` and `VITE_PROXY_HMAC_KEY` in `.env`. The host
allowlist and the `Origin` check are what keep this from being an open proxy;
the HMAC raises the cost for a passer-by but is not a real secret, since it
ships in the client bundle.

### Catalog + sync (§6.2, §6.3)

```bash
supabase db push          # or paste supabase/migrations/*.sql into the SQL editor
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run ingest -- --source=all
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` and the app switches from
the live-API adapter to one query per search against your own index, with
ranking you control. The nightly job is `npm run ingest`; matching runs in
Postgres via `rebuild_edition_links()`.

## Decisions the design left open (§10)

The design flagged four questions. Resolved as follows — each is a one-file
change if you'd rather go the other way.

| Question | Decision | Where |
|---|---|---|
| **Auth** | Supabase magic link, plus a local-only mode when Supabase is unconfigured. A hardcoded long-lived token is simpler but sits in the bundle forever with no way to rotate; magic link costs one screen. | `src/core/supabase-client.ts` |
| **Annotations** | EPUB CFI locators throughout, with Markdown and JSON export that carries the quote, chapter, source URL and CFI — so a highlight moves into the commonplace book without losing provenance. Sharing one Supabase project is then a schema decision you can still make. | `src/reader/annotations.ts` |
| **Great Books** | Implemented as curated collections: a `collections` store with a seed list, and shelf entries that show what you don't own yet with a link to find it. | `src/core/collections.ts`, `src/core/great-books.ts` |
| **Multi-device** | iPhone-first, responsive to desktop widths. Mac Safari works; nothing is designed around it. | `src/styles/app.css` |

## Where reality differed from the design

- **Standard Ebooks' bulk feeds now need authentication.** `/feeds/opds/all` and
  `/feeds/atom/all` answer `401` with `WWW-Authenticate: Basic realm="Enter your
  Patrons Circle email address…"`. Only `/feeds/atom/new-releases` (15 books) is
  public. The proxy Worker holds the credential (`SE_OPDS_EMAIL`) and attaches
  it server-side so it never ships to the client; without it, both the app and
  the ingest degrade to the public feed and Gutenberg carries the breadth.
- **iOS makes `HTMLMediaElement.volume` read-only.** The sleep timer's 20-second
  fade-out is a no-op on the phone, so the timer just pauses. The player
  detects this at boot (`isVolumeSettable()`) and the UI says which you'll get.
  Routing through a Web Audio `GainNode` would restore the fade but risks the
  background-audio session, which is the thing the whole feature depends on.
- **`navigator.connection` is unavailable on iOS Safari**, so the cellular
  warning is a manual setting with a size threshold rather than a smart check —
  as the design anticipated (§7.5).

## Status

Built and verified: type-checks clean, 47 tests pass, production build succeeds,
`dist/sw.js` is self-contained. **Nothing has been exercised on an actual
iPhone** — every iOS-specific behaviour in §3.1 is still a hypothesis, which is
what the spikes are for. Run those before trusting the rest.

Against the milestones (§9): M1–M5 are implemented in code. M0 is the gate that
hasn't been run.
