import {useLayoutEffect, useRef} from 'react';
import type {HTMLAttributes, ReactNode} from 'react';
import {createPortal} from 'react-dom';

export type PreviewAnchor = {x: number; y: number; top: number; bottom: number};

type Props = {
  id: string;
  anchor: PreviewAnchor;
  fontScale: number;
  children: ReactNode;
} & Pick<HTMLAttributes<HTMLElement>, 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'>;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export function QuestionPreview({id, anchor, fontScale, children, ...interaction}: Props) {
  const card = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const fit = () => {
      const margin = 12 * fontScale, gap = 10 * fontScale;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const maxWidth = Math.max(1, viewportWidth - margin * 2);
      const maxHeight = Math.max(1, viewportHeight - margin * 2);
      const below = Math.max(0, viewportHeight - margin - anchor.bottom - gap);
      const above = Math.max(0, anchor.top - gap - margin);
      let width = Math.min(maxWidth, 560 * fontScale);
      element.style.maxHeight = `${maxHeight}px`;
      element.style.width = `${width}px`;
      const naturalHeight = () => element.scrollHeight + element.offsetHeight - element.clientHeight;
      let height = naturalHeight();
      let top: number, left = anchor.x - Math.min(80, width * .2);
      const fitsRight = anchor.x + gap + width <= viewportWidth - margin;
      const fitsLeft = anchor.x - gap - width >= margin;
      const compact = height <= Math.max(above, below) || height <= maxHeight && (fitsRight || fitsLeft);
      if (compact) {
        // A normal preview keeps following the pointer wherever it fits.
        if (height <= below) top = anchor.bottom + gap;
        else if (height <= above) top = anchor.top - gap - height;
        else {
          left = fitsRight ? anchor.x + gap : anchor.x - gap - width;
          top = anchor.y - height / 2;
        }
        left = clamp(left, margin, viewportWidth - margin - width);
      } else {
        // Only the expanded fallback reserves the left fifth for the question list.
        const reservedLeft = Math.max(margin, viewportWidth / 5);
        const expandedWidth = Math.max(1, viewportWidth - margin - reservedLeft);
        width = Math.min(width, expandedWidth);
        element.style.width = `${width}px`;
        height = naturalHeight();
        while (height > Math.max(above, below) && width < expandedWidth) {
          width = Math.min(expandedWidth, width + 120 * fontScale);
          element.style.width = `${width}px`;
          height = naturalHeight();
        }
        left = viewportWidth - margin - width;
        height = Math.min(height, maxHeight);
        top = height <= below ? anchor.bottom + gap
          : height <= above ? anchor.top - gap - height : anchor.y - height / 2;
      }
      top = clamp(top, margin, viewportHeight - margin - height);
      Object.assign(element.style, {
        left: `${left}px`, top: `${top}px`, visibility: 'visible',
      });
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    window.addEventListener('resize', fit);
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, [anchor, fontScale, children]);

  return createPortal(<section id={id} className="question-preview" role="dialog" aria-label="题目预览" tabIndex={-1} ref={card} {...interaction}>
    {children}
  </section>, document.body);
}
