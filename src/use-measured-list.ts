import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {revealRow, rowAtOffset, rowOffsets} from './variable-rows';

type Row = {rowid: number};

export function useMeasuredList(items: readonly Row[], fontScale: number, resetKey: string) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({width: 0, height: 600});
  const [measurement, setMeasurement] = useState(0);
  const heights = useMemo(() => new Map<number, number>(), [fontScale, size.width, resetKey]);
  const offsets = useMemo(() => rowOffsets(items.map(row => heights.get(row.rowid) ?? Math.ceil(94 * fontScale))), [items, heights, measurement, fontScale]);
  const previous = useRef({items, offsets, resetKey, scrollTop: 0});
  const pendingTarget = useRef<number | null>(null);
  const start = Math.max(0, rowAtOffset(offsets, scrollTop) - 3);
  const end = Math.min(items.length, rowAtOffset(offsets, scrollTop + size.height) + 4);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const update = () => {
      const width = element.clientWidth, height = element.clientHeight;
      setSize(old => old.width === width && old.height === height ? old : {width, height});
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = viewport.current, old = previous.current;
    if (!element) return;
    let nextScroll = old.scrollTop;
    if (old.resetKey !== resetKey) {
      nextScroll = 0;
      pendingTarget.current = null;
    } else if (old.offsets !== offsets && old.items.length && items.length) {
      // Keep the same question and offset in view when rows above it resize.
      const anchor = rowAtOffset(old.offsets, old.scrollTop);
      const index = items.findIndex(row => row.rowid === old.items[anchor].rowid);
      if (index >= 0) nextScroll = offsets[index] + Math.min(old.scrollTop - old.offsets[anchor], offsets[index + 1] - offsets[index] - 1);
    }
    if (pendingTarget.current !== null) {
      const index = items.findIndex(row => row.rowid === pendingTarget.current);
      if (index >= 0) {
        nextScroll = revealRow(offsets[index], offsets[index + 1], nextScroll, element.clientHeight);
        if (heights.has(items[index].rowid)) pendingTarget.current = null;
      }
    }
    element.scrollTop = Math.max(0, nextScroll);
    previous.current = {items, offsets, resetKey, scrollTop: element.scrollTop};
    setScrollTop(element.scrollTop);
  }, [items, offsets, resetKey, heights, size.height]);

  useLayoutEffect(() => {
    const rows = viewport.current?.querySelectorAll<HTMLElement>('[data-measured-row]');
    if (!rows) return;
    const measure = () => {
      let changed = false;
      for (const row of rows) {
        const id = Number(row.dataset.measuredRow), height = row.getBoundingClientRect().height;
        if (height > 0 && Math.abs((heights.get(id) ?? 0) - height) > .25) {
          heights.set(id, height);
          changed = true;
        }
      }
      if (changed) setMeasurement(value => value + 1);
    };
    const observer = new ResizeObserver(measure);
    for (const row of rows) observer.observe(row);
    measure();
    return () => observer.disconnect();
  }, [items, heights, start, end]);

  function onScroll() {
    if (!viewport.current) return;
    previous.current.scrollTop = viewport.current.scrollTop;
    setScrollTop(viewport.current.scrollTop);
  }
  function scrollToIndex(index: number) {
    const element = viewport.current;
    if (!element || !items[index]) return;
    pendingTarget.current = heights.has(items[index].rowid) ? null : items[index].rowid;
    element.scrollTop = revealRow(offsets[index], offsets[index + 1], element.scrollTop, element.clientHeight);
    onScroll();
  }
  function cancelTarget() { pendingTarget.current = null; }

  return {viewport, start, end, offsets, totalHeight: offsets[items.length], scrollTop, height: size.height, onScroll, scrollToIndex, cancelTarget};
}
