import {flushSync} from 'react-dom';

const activeAnimations = new WeakMap<HTMLElement, Animation[]>();
const timing: KeyframeAnimationOptions = {duration: 240, easing: 'cubic-bezier(.2,.75,.25,1)'};

// Measure only when the user folds the search area. Keep the input mounted so
// its value, selection and IME composition survive the layout change.
export function animateSearchLayout(container: HTMLElement | null, update: () => void) {
  if (!container) { update(); return; }
  const before = container.getBoundingClientRect();
  const moving = Array.from(container.querySelectorAll<HTMLElement>('.search-box, .filter-row'))
    .map(element => ({element, rect: element.getBoundingClientRect()}));
  // Capture the currently visible frame before cancelling, so another click
  // can reverse an in-flight transition without jumping to its old endpoint.
  activeAnimations.get(container)?.forEach(animation => animation.cancel());
  activeAnimations.delete(container);
  flushSync(update);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const after = container.getBoundingClientRect();
  const animations = [container.animate([
    {height: `${before.height}px`}, {height: `${after.height}px`},
  ], timing)];
  for (const {element, rect} of moving) {
    const next = element.getBoundingClientRect();
    animations.push(element.animate([
      {transform: `translate(${rect.left - next.left}px, ${rect.top - next.top}px)`},
      {transform: 'translate(0, 0)'},
    ], timing));
  }
  const title = container.querySelector<HTMLElement>('.title-line');
  if (title && title.getBoundingClientRect().height > 0) {
    animations.push(title.animate([
      {opacity: 0, transform: 'translateY(-8px)'},
      {opacity: 1, transform: 'translateY(0)'},
    ], timing));
  }
  activeAnimations.set(container, animations);
}
