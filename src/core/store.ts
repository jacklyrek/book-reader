/**
 * A ~40 line observable store. The design calls for no framework or a small
 * one (§5); this is the whole state-management layer.
 */
import { useEffect, useState } from 'preact/hooks'

export interface Store<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  subscribe(fn: (value: T) => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<(v: T) => void>()
  return {
    get: () => value,
    set(next) {
      const resolved =
        typeof next === 'function' ? (next as (prev: T) => T)(value) : next
      if (Object.is(resolved, value)) return
      value = resolved
      for (const fn of listeners) fn(value)
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

export function useStore<T>(store: Store<T>): T {
  const [value, setValue] = useState(store.get)
  useEffect(() => {
    setValue(store.get())
    return store.subscribe(setValue)
  }, [store])
  return value
}

/** Selector variant, so a component only rerenders when its slice changes. */
export function useStoreSelector<T, S>(store: Store<T>, select: (value: T) => S): S {
  const [value, setValue] = useState(() => select(store.get()))
  useEffect(() => {
    const update = (v: T) => {
      const next = select(v)
      setValue((prev) => (Object.is(prev, next) ? prev : next))
    }
    update(store.get())
    return store.subscribe(update)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])
  return value
}

/** Re-run an async loader whenever `deps` change. Returns a loading tri-state. */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{
    data: T | undefined
    error: Error | undefined
    loading: boolean
  }>({ data: undefined, error: undefined, loading: true })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    load()
      .then((data) => {
        if (!cancelled) setState({ data, error: undefined, loading: false })
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({
            data: undefined,
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { ...state, reload: () => setNonce((n) => n + 1) }
}
