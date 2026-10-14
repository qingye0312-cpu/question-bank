import {useLayoutEffect, useRef} from 'react';
import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';

export type PreviewAnchor = {x: number; y: number; top: number; bottom: number};

type Props = {
  id: string;
  anchor: PreviewAnchor;
  fontScale: number;
  children: ReactNode;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export function QuestionPreview({id, anchor, fontScale, children}: Props) {
  const card = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const fit = () => {
      const margin = 12, gap = 10;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const maxWidth = Math.max(1, viewportWidth - margin * 2);
      const maxHeight = Math.max(1, viewportHeight - margin * 2);
      const below = Math.max(0, viewportHeight - margin - anchor.bottom - gap);
      const above = Math.max(0, anchor.top - gap - margin);
      const room = Math.max(above, below);
      let width = Math.min(maxWidth, Math.max(360, 560 * fontScale));
      const step = Math.max(120, (maxWidth - width) / 4);

      // Measure the complete content before painting. Widen the card until it
      // fits beside the row vertically, instead of clipping or adding a scroller.
      element.style.width = `${width}px`;
      let height = element.offsetHeight;
      while (height > room && width < maxWidth) {
        width = Math.min(maxWidth, width + step);
        element.style.width = `${width}px`;
        height = element.offsetHeight;
      }

      // Even a future oversized question remains fully visible without a second
      // scrollbar. Normal questions retain the user's chosen font size.
      const scale = Math.min(1, maxHeight / Math.max(1, height));
      const renderedWidth = width * scale, renderedHeight = height * scale;
      let top = renderedHeight <= below ? anchor.bottom + gap
        : renderedHeight <= above ? anchor.top - gap - renderedHeight
        : anchor.y - renderedHeight / 2;
      let left = anchor.x - Math.min(80, renderedWidth * .2);
      if (renderedHeight > room) {
        // If neither above nor below fits, use the side of the pointer when possible.
        if (anchor.x + gap + renderedWidth <= viewportWidth - margin) left = anchor.x + gap;
        else if (anchor.x - gap - renderedWidth >= margin) left = anchor.x - gap - renderedWidth;
      }
      top = clamp(top, margin, viewportHeight - margin - renderedHeight);
      left = clamp(left, margin, viewportWidth - margin - renderedWidth);
      Object.assign(element.style, {
        left: `${left}px`, top: `${top}px`, transform: `scale(${scale})`, visibility: 'visible',
      });
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    window.addEventListener('resize', fit);
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, [anchor, fontScale, children]);

  // The preview never intercepts the pointer, so moving straight to another row
  // changes the preview immediately and cannot trigger an enter/leave loop.
  return createPortal(<section id={id} className="question-preview" role="tooltip" ref={card}>
    {children}
  </section>, document.body);
}
