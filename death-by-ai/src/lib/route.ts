import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

export function navigate(path: string, replace = false): void {
  if (path === location.pathname) return
  if (replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  for (const listener of listeners) listener()
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname)
}
