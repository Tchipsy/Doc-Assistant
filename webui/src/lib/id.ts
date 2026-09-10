let seq = 0
export function uid(prefix: string): string {
  seq = (seq + 1) % 1000
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 6)}`
}
