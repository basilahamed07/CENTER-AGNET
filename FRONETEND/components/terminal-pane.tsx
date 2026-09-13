'use client'

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { MoreHorizontal } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { LIVE_STATUSES, type AgentSession } from '@/lib/types'

export function TerminalPane({ session, visible, socket }: { session?: AgentSession; visible?: boolean; socket: Socket | null }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const sessionId = session?.id
  const fitRef = useRef<(() => void) | null>(null)
  const isLive = !!session && LIVE_STATUSES.includes(session.status)
  const [outputSeen, setOutputSeen] = useState(false)
  // Reset the output flag when switching sessions (React-endorsed
  // "adjust state during render" pattern instead of a setState effect).
  const [prevSessionId, setPrevSessionId] = useState(sessionId)
  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId)
    setOutputSeen(false)
  }
  useEffect(() => {
    if (!ref.current || !sessionId || !socket || !isLive) return
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'JetBrains Mono, Consolas, monospace', fontSize: 12, theme: { background: '#05080d', foreground: '#c9d6e4', cursor: '#29e0ff', cursorAccent: '#05080d', selectionBackground: '#12414d', black: '#0c1017', green: '#34e8b0', cyan: '#29e0ff', brightBlack: '#5c6b80' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(ref.current)
    const fitTerminal = () => {
      fit.fit()
      // Guard: skip resize while the pane has no real layout (xterm defaults 80x24,
      // and a fit on a hidden/zero-size pane can produce tiny rows that the
      // manager would reject).
      if (terminal.cols < 20 || terminal.rows < 5) return
      socket.emit('terminal.resize', { sessionId, cols: terminal.cols, rows: terminal.rows })
    }
    fitRef.current = fitTerminal
    window.setTimeout(fitTerminal, 0)
    window.setTimeout(fitTerminal, 120)
    socket.emit('terminal.attach', { sessionId })
    const outputHandler = (event: { sessionId?: string; payload?: { data?: string } }) => { if (event.sessionId === sessionId && event.payload?.data) { setOutputSeen(true); terminal.write(event.payload.data) } }
    socket.on('terminal.output', outputHandler)
    terminal.onData((data) => socket.emit('terminal.input', { sessionId, data }))
    const observer = new ResizeObserver(() => fitTerminal())
    observer.observe(ref.current)
    window.addEventListener('resize', fitTerminal)
    return () => { fitRef.current = null; observer.disconnect(); window.removeEventListener('resize', fitTerminal); socket.off('terminal.output', outputHandler); terminal.dispose() }
  }, [sessionId, socket, isLive])
  // Refit when this pane becomes the visible tab (it had zero size while hidden).
  useEffect(() => {
    if (!visible) return
    const t1 = window.setTimeout(() => fitRef.current?.(), 0)
    const t2 = window.setTimeout(() => fitRef.current?.(), 80)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
  }, [visible])
  if (!session) return <div className="terminal-pane"><div className="empty-state">No session selected.</div></div>
  if (!isLive) return <div className="terminal-pane"><div className="terminal-pane-header"><span><span className="terminal-dot-dead" /> {session.display_name}</span><small>{session.working_directory}</small><MoreHorizontal /></div><div className="terminal-dead-note"><b>{session.status}</b> — this session is not running, so there is no live terminal. Use <b>Resume</b> (if supported) or <b>Restart</b> from the session detail, or launch the agent again.</div></div>
  return <div className="terminal-pane"><div className="terminal-pane-header"><span><span className="terminal-green" /> {session.display_name}</span><small>{session.working_directory}</small><MoreHorizontal /></div><div className="xterm-host" ref={ref} />{!outputSeen && <div className="terminal-waiting-note">Waiting for output from the agent process… (PID {session.process_id ?? '-'})</div>}</div>
}
