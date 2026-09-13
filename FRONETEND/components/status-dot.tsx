export function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${status.toLowerCase()}`} aria-label={status} />
}
