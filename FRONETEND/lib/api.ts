export const MANAGER_URL = process.env.NEXT_PUBLIC_MANAGER_URL ?? 'http://127.0.0.1:4242'

/** Typed fetch wrapper for the manager REST API. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${MANAGER_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  } catch {
    throw new Error(`Manager unreachable at ${MANAGER_URL} — start it with 'npm run start:detached' in BACKEND`)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string }
    throw new Error(body.error ?? response.statusText)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
