/**
 * Read ↔ listen handoff, chapter-level (§7.4 tier 1).
 *
 * The design is explicit about being realistic here. Word-level alignment needs
 * a server-side Whisper/aeneas batch job and is not v1; EPUB 3 Media Overlays
 * are a real standard that almost no public domain book ships. What is left is
 * mapping spine items to LibriVox sections, which are usually 1:1 because
 * LibriVox sections follow chapters. Switching modes drops you at the top of
 * the current chapter. Cheap, and right about 90% of the time.
 */
import { similarity } from '../catalog/match'
import { normalizeTitle } from '../core/ids'
import type { AudioTrack } from '../core/types'

export interface SpineEntry {
  index: number
  /** TOC label for the section, when the book has one. */
  label?: string
}

export interface Mapping {
  /** spineIndex → trackIndex */
  toTrack: Map<number, number>
  /** trackIndex → spineIndex */
  toSpine: Map<number, number>
  strategy: 'one-to-one' | 'label-match' | 'proportional'
  confidence: number
}

/** LibriVox section titles are noisy: "01 - Chapter 1: The Loomings". */
function cleanTrackTitle(title: string): string {
  return normalizeTitle(
    title
      .replace(/^\s*\d+\s*[-–—.:]\s*/, '')
      .replace(/\bsection\s+\d+\b/gi, '')
      .replace(/\bpart\s+\d+\b/gi, ''),
  )
}

/**
 * Build a bidirectional chapter map. Tries the cheap assumption first, then
 * label matching, then falls back to proportional position.
 */
export function buildMapping(spine: SpineEntry[], tracks: AudioTrack[]): Mapping {
  const toTrack = new Map<number, number>()
  const toSpine = new Map<number, number>()

  if (spine.length === 0 || tracks.length === 0) {
    return { toTrack, toSpine, strategy: 'proportional', confidence: 0 }
  }

  // 1:1 — the common case, since LibriVox sections follow chapters.
  if (spine.length === tracks.length) {
    spine.forEach((entry, i) => {
      const track = tracks[i]
      if (!track) return
      toTrack.set(entry.index, track.trackIndex)
      toSpine.set(track.trackIndex, entry.index)
    })
    return { toTrack, toSpine, strategy: 'one-to-one', confidence: 0.9 }
  }

  // Label matching. Works when the EPUB has front matter the recording skips.
  const labelled = spine.filter((s) => s.label && s.label.trim().length > 2)
  if (labelled.length > 0) {
    const used = new Set<number>()
    let scoreSum = 0
    let matched = 0

    for (const entry of labelled) {
      const needle = normalizeTitle(entry.label ?? '')
      let best = -1
      let bestScore = 0
      tracks.forEach((track, i) => {
        if (used.has(i)) return
        const score = similarity(needle, cleanTrackTitle(track.title))
        if (score > bestScore) {
          bestScore = score
          best = i
        }
      })
      const track = best >= 0 ? tracks[best] : undefined
      if (track && bestScore >= 0.55) {
        used.add(best)
        toTrack.set(entry.index, track.trackIndex)
        toSpine.set(track.trackIndex, entry.index)
        scoreSum += bestScore
        matched++
      }
    }

    if (matched >= Math.min(3, labelled.length)) {
      const coverage = matched / labelled.length
      return {
        toTrack,
        toSpine,
        strategy: 'label-match',
        confidence: (scoreSum / matched) * coverage,
      }
    }
    toTrack.clear()
    toSpine.clear()
  }

  // Last resort: proportional. Better than dumping the user at chapter one.
  spine.forEach((entry, i) => {
    const trackPos = Math.min(
      tracks.length - 1,
      Math.floor((i / spine.length) * tracks.length),
    )
    const track = tracks[trackPos]
    if (track) toTrack.set(entry.index, track.trackIndex)
  })
  tracks.forEach((track, i) => {
    const spinePos = Math.min(
      spine.length - 1,
      Math.floor((i / tracks.length) * spine.length),
    )
    const entry = spine[spinePos]
    if (entry) toSpine.set(track.trackIndex, entry.index)
  })

  return { toTrack, toSpine, strategy: 'proportional', confidence: 0.35 }
}

/** Where to start listening, given where the reader currently is. */
export function trackForSpine(mapping: Mapping, spineIndex: number): number {
  const exact = mapping.toTrack.get(spineIndex)
  if (exact !== undefined) return exact
  // Nearest mapped section at or before this one.
  let best = 0
  for (const [spine, track] of mapping.toTrack) {
    if (spine <= spineIndex && spine >= best) best = track
  }
  return best
}

/** …and the reverse, for "read from here" while listening. */
export function spineForTrack(mapping: Mapping, trackIndex: number): number {
  const exact = mapping.toSpine.get(trackIndex)
  if (exact !== undefined) return exact
  let best = 0
  for (const [track, spine] of mapping.toSpine) {
    if (track <= trackIndex && track >= best) best = spine
  }
  return best
}

/** Shown next to the handoff button so the user knows how much to trust it. */
export function describeMapping(mapping: Mapping): string {
  switch (mapping.strategy) {
    case 'one-to-one':
      return 'Chapters line up with the recording’s sections.'
    case 'label-match':
      return `Matched ${mapping.toTrack.size} chapters by title (${Math.round(
        mapping.confidence * 100,
      )}% confidence).`
    case 'proportional':
      return 'No chapter map — jumping to roughly the same place in the recording.'
  }
}
