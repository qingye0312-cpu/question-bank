let generation = 0;

/** Marks a Mini Program foreground entry, not an in-app page navigation. */
export function markForegroundEntry(): void {
  generation++;
}

export function foregroundGeneration(): number {
  return generation;
}
