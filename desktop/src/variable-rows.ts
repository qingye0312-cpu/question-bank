export function rowOffsets(heights: readonly number[]): number[] {
  const offsets = [0];
  for (const height of heights) offsets.push(offsets[offsets.length - 1] + height);
  return offsets;
}

// Find the row containing a scroll position; an exact boundary starts the next row.
export function rowAtOffset(offsets: readonly number[], position: number): number {
  let low = 0, high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1] <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function revealRow(top: number, bottom: number, scrollTop: number, viewportHeight: number): number {
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - top >= viewportHeight ? top : bottom - viewportHeight;
  return scrollTop;
}
