/**
 * Encode a string to base64.
 * @param input
 */
export function encode(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64')
}

/**
 * Decode a base64 encoded string.
 * @param input
 */
export function decode(input: string): string {
  return Buffer.from(input, 'base64').toString('utf-8')
}
