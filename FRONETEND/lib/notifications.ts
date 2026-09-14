/**
 * Browser/desktop notifications (spec §16).
 *
 * Only reliable process events trigger notifications — never inferred "task
 * completed". Toggles live in localStorage so they survive restarts, and
 * notification permission is requested lazily on first enable (never on page
 * load, which browsers treat as spam).
 */

export type NotificationKind = 'error' | 'exit' | 'output' | 'disconnect'

const STORAGE_KEY = 'forge.notifications'

export interface NotificationSettings {
  error: boolean
  exit: boolean
  output: boolean
  disconnect: boolean
}

const DEFAULT_SETTINGS: NotificationSettings = {
  error: true,
  exit: true,
  output: false,
  disconnect: true,
}

export function loadNotificationSettings(): NotificationSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>
    return {
      error: parsed.error ?? DEFAULT_SETTINGS.error,
      exit: parsed.exit ?? DEFAULT_SETTINGS.exit,
      output: parsed.output ?? DEFAULT_SETTINGS.output,
      disconnect: parsed.disconnect ?? DEFAULT_SETTINGS.disconnect,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveNotificationSettings(settings: NotificationSettings) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Private mode / storage disabled: in-page toasts still work.
  }
}

/**
 * Live permission state for the settings UI: 'unsupported' | 'default' |
 * 'granted' | 'denied'. Re-read whenever the settings modal opens.
 */
export function getNotificationPermission(): 'unsupported' | 'default' | 'granted' | 'denied' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return window.Notification.permission
}

/** Ask once, lazily, when the user enables a toggle. Resolves to usable or not. */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false
  if (window.Notification.permission === 'granted') return true
  if (window.Notification.permission === 'denied') return false
  const result = await window.Notification.requestPermission()
  return result === 'granted'
}

/**
 * Fire a desktop notification. Callers already checked the per-kind toggle;
 * this checks API availability + permission and swallows all failures —
 * notifications must never break the app.
 */
export function showDesktopNotification(title: string, body: string) {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (window.Notification.permission !== 'granted') return
    new window.Notification(title, { body, silent: false })
  } catch {
    // Some engines restrict the constructor; a failed notification is a no-op.
  }
}
