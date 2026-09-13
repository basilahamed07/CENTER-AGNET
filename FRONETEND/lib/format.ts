/** Last path segment of a command or file path (handles \\ and /). */
export function fileLabel(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

/** Bytes → a compact MB string. */
export function formatBytes(value: number) {
  return value ? `${(value / 1024 / 1024).toFixed(0)} MB` : '0 MB'
}
