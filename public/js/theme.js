/**
 * Light / dark / system theme switcher.
 *
 * The choice lives on <html data-theme>: "light" or "dark" pins a theme, and
 * no attribute means "follow the OS" (the stylesheet handles that with
 * prefers-color-scheme). An inline script in index.html applies a saved
 * choice before first paint; this module only drives the toggle buttons.
 */

const STORAGE_KEY = 'chess-theme';
const SYSTEM = 'system';
const CHOICES = new Set([SYSTEM, 'light', 'dark']);

/** @param {HTMLElement} group Container of `button[data-theme-choice]`. */
export function initThemeSwitcher(group) {
  const root = document.documentElement;

  const apply = (choice) => {
    if (choice === SYSTEM) delete root.dataset.theme;
    else root.dataset.theme = choice;

    for (const button of group.querySelectorAll('button[data-theme-choice]')) {
      const active = button.dataset.themeChoice === choice;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  };

  apply(root.dataset.theme ?? SYSTEM);

  group.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-theme-choice]');
    const choice = button?.dataset.themeChoice;
    if (!CHOICES.has(choice)) return;

    try {
      if (choice === SYSTEM) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      /* storage blocked: the choice still applies for this visit */
    }
    apply(choice);
  });
}
