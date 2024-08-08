export function note(message: string): string {
  return `> [!NOTE]\n> ${message}`
}

export function tip(message: string): string {
  return `> [!TIP]\n> ${message}`
}

export function important(message: string): string {
  return `> [!IMPORTANT]\n> ${message}`
}

export function warning(message: string): string {
  return `> [!WARNING]\n> ${message}`
}

export function caution(message: string): string {
  return `> [!CAUTION]\n> ${message}`
}

export function hidden(message: string): string {
  return `[//]: # (${message})`
}
