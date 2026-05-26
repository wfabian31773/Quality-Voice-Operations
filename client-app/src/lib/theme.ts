import { create } from 'zustand';

interface ThemeState {
  dark: boolean;
  toggle: () => void;
}

/**
 * Apply the theme state to <html>.
 *
 * We set BOTH:
 *   - `.dark` class      — for Tailwind's `dark:` variant utilities
 *   - `data-theme` attr  — for the QVO brand kit's `[data-theme="dark"]`
 *                          selector (defined in `brand/qvo-global.css`)
 *
 * Keeping both in sync means a single toggle flips every consumer:
 * Tailwind utilities, QVO token overrides, and any `.dark` selector
 * we already had in tw-public.css / tw-app.css.
 */
function applyTheme(dark: boolean) {
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}

export const useTheme = create<ThemeState>((set) => ({
  dark: localStorage.getItem('theme') === 'dark',
  toggle: () =>
    set((s) => {
      const next = !s.dark;
      localStorage.setItem('theme', next ? 'dark' : 'light');
      applyTheme(next);
      return { dark: next };
    }),
}));

// Apply the persisted theme on first paint (before React mounts) so we
// don't get a flash of the wrong palette.
applyTheme(localStorage.getItem('theme') === 'dark');
