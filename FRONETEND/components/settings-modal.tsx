'use client'

import { useState } from 'react'
import { Bell, BellOff, Send } from 'lucide-react'
import {
  getNotificationPermission,
  loadNotificationSettings,
  requestNotificationPermission,
  saveNotificationSettings,
  showDesktopNotification,
  type NotificationSettings,
} from '@/lib/notifications'

const KINDS: Array<{ key: keyof NotificationSettings; label: string; hint: string }> = [
  { key: 'error', label: 'Process error', hint: 'Agent crashed or failed to start' },
  { key: 'exit', label: 'Process exit', hint: 'Agent finished or was stopped' },
  { key: 'output', label: 'New output', hint: 'Any terminal produced output (can be noisy)' },
  { key: 'disconnect', label: 'Session disconnected', hint: 'Terminal stopped responding' },
]

const PERMISSION_LABEL: Record<string, string> = {
  granted: 'Allowed',
  default: 'Not asked yet',
  denied: 'Blocked',
  unsupported: 'Not supported',
}

type Permission = ReturnType<typeof getNotificationPermission>

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<NotificationSettings>(() => loadNotificationSettings())
  const [permission, setPermission] = useState<Permission>(() => getNotificationPermission())
  const [permissionHint, setPermissionHint] = useState<string | null>(null)
  const [testSent, setTestSent] = useState(false)

  async function toggle(kind: keyof NotificationSettings) {
    const next = { ...settings, [kind]: !settings[kind] }
    if (next[kind]) {
      // Enabling a toggle: make sure we have permission before saving.
      if (!(await requestNotificationPermission())) {
        setPermission(getNotificationPermission())
        setPermissionHint('Desktop notifications are blocked for this site — the in-app toasts still work.')
      } else {
        setPermission('granted')
        setPermissionHint(null)
      }
    }
    setSettings(next)
    saveNotificationSettings(next)
  }

  function sendTest() {
    // Same code path as real notifications: if permission is missing this is
    // a silent no-op, which is exactly why the status row exists.
    showDesktopNotification('FORGE test', 'Desktop notifications are working ✅')
    setTestSent(true)
    window.setTimeout(() => setTestSent(false), 2500)
  }

  return (
    <div className="settings-form">
      <div className="form-hint">
        Desktop notifications fire only for reliable process events — never for inferred &quot;task finished&quot;.
      </div>

      <div className={`permission-row ${permission}`}>
        {permission === 'granted'
          ? <Bell />
          : <BellOff />}
        <div className="permission-copy">
          <b>Browser permission: {PERMISSION_LABEL[permission] ?? permission}</b>
          {permission === 'denied' && (
            <small>
              Your browser blocked notifications for this site. To unblock: click the 🔒 / icon
              left of the address bar → <b>Notifications</b> → <b>Allow</b>, then reload this page.
              Site settings may also be under the (i) info icon.
            </small>
          )}
          {permission === 'default' && (
            <small>Flip any toggle below — the browser will ask once for permission.</small>
          )}
          {permission === 'unsupported' && (
            <small>This browser (or an embedded webview) has no Notification API. In-app toasts still work.</small>
          )}
          {permission === 'granted' && (
            <small>Permission granted — toggles below control which events notify you.</small>
          )}
        </div>
      </div>

      {KINDS.map((kind) => (
        <label className="form-check" key={kind.key}>
          <input type="checkbox" checked={settings[kind.key]} onChange={() => void toggle(kind.key)} />
          <span>
            <Bell style={{ width: 12, verticalAlign: 'middle', marginRight: 4 }} /> {kind.label}
            <small style={{ display: 'block', color: '#67748a' }}>{kind.hint}</small>
          </span>
        </label>
      ))}

      <button type="button" className="secondary-button" style={{ alignSelf: 'flex-start' }} onClick={sendTest}>
        <Send /> {testSent ? 'Sent (check your screen)' : 'Send test notification'}
      </button>

      {permissionHint && <div className="form-hint">{permissionHint}</div>}
      <div className="form-actions">
        <button type="button" className="primary-button" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
