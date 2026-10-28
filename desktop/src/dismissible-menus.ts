const selector = 'details[data-action-menu][open]';

/** Close action menus only; inline details sections keep their expanded state. */
export function dismissActionMenus(root: ParentNode = document, restoreFocus = false): boolean {
  const menus = [...root.querySelectorAll<HTMLDetailsElement>(selector)];
  for (const menu of menus) menu.open = false;
  if (restoreFocus) menus.at(-1)?.querySelector('summary')?.focus({preventScroll: true});
  return menus.length > 0;
}

export function bindDismissibleMenus(root: HTMLElement): () => void {
  const document = root.ownerDocument;
  const window = document.defaultView!;
  const close = () => { dismissActionMenus(root); };
  const closeOutside = (event: Event) => {
    const target = event.target;
    for (const menu of root.querySelectorAll<HTMLDetailsElement>(selector)) {
      if (!(target instanceof Node) || !menu.contains(target)) menu.open = false;
    }
  };
  const toggle = (event: Event) => {
    const menu = event.target;
    if (menu instanceof HTMLDetailsElement && menu.matches(selector)) closeOutside(event);
  };
  const action = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const menu = button?.closest<HTMLDetailsElement>(selector);
    if (!button || button.disabled || !menu) return;
    const restoreFocus = menu.contains(document.activeElement);
    menu.open = false;
    // Keyboard actions should return focus to the trigger, even after reordering.
    if (restoreFocus) menu.querySelector('summary')?.focus({preventScroll: true});
  };
  const visibility = () => { if (document.hidden) close(); };

  document.addEventListener('pointerdown', closeOutside, true);
  document.addEventListener('focusin', closeOutside, true);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', close);
  root.addEventListener('toggle', toggle, true);
  root.addEventListener('click', action);
  return () => {
    close();
    document.removeEventListener('pointerdown', closeOutside, true);
    document.removeEventListener('focusin', closeOutside, true);
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('blur', close);
    root.removeEventListener('toggle', toggle, true);
    root.removeEventListener('click', action);
  };
}
