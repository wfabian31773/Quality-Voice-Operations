import { create } from 'zustand';

interface ThemeState {
  dark: boolean;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set) => ({
  dark: localStorage.getItem('theme') === 'dark',
  toggle: () =>
    set((s) => {
      const next = !s.dark;
      localStorage.setItem('theme', next ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', next);
      return { dark: next };
    }),
}));

if (localStorage.getItem('theme') === 'dark') {
  document.documentElement.classList.add('dark');
}
