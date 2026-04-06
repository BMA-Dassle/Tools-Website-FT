/** Minimal cn() — joins class names, filters falsy values */
export function cn(...inputs: (string | undefined | null | false)[]): string {
  return inputs.filter(Boolean).join(" ");
}
