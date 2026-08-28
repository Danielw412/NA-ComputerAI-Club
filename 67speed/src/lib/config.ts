/** Settings that must survive a reload — you will be adjusting these at the venue. */
import { DEFAULT_REP_CONFIG, type RepConfig } from './pose/repCounter'
import { DEFAULT_TRACKER_OPTIONS, type TrackerOptions } from './pose/tracker'

const REP_KEY = 'cai67:repConfig:v2'
const TRACKER_KEY = 'cai67:tracker:v1'

function load<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { ...defaults }
    return { ...defaults, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    return { ...defaults }
  }
}

function save(key: string, value: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode / storage disabled — settings just won't persist */
  }
}

export const loadRepConfig = (): RepConfig => load(REP_KEY, DEFAULT_REP_CONFIG)
export const saveRepConfig = (cfg: RepConfig): void => save(REP_KEY, cfg)

export const loadTrackerOptions = (): TrackerOptions => load(TRACKER_KEY, DEFAULT_TRACKER_OPTIONS)
export const saveTrackerOptions = (opts: TrackerOptions): void => save(TRACKER_KEY, opts)

export function resetAllSettings(): void {
  try {
    localStorage.removeItem(REP_KEY)
    localStorage.removeItem(TRACKER_KEY)
  } catch {
    /* ignore */
  }
}
