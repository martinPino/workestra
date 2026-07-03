import { create } from 'zustand';

type Theme = 'dark' | 'light';
export type Lang = 'es' | 'en';

interface UIState {
  theme: Theme;
  lang: Lang;
  collapsed: boolean;
  cmdOpen: boolean;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setLang: (l: Lang) => void;
  toggleCollapsed: () => void;
  setCmdOpen: (v: boolean) => void;
}

const ls = {
  get(key: string, fallback: string): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};

export const applyTheme = (theme: Theme): void => {
  document.documentElement.setAttribute('data-theme', theme);
};

export const useUI = create<UIState>((set, get) => ({
  theme: ls.get('af.theme', 'dark') as Theme,
  lang: ls.get('af.lang', 'es') as Lang,
  collapsed: ls.get('af.collapsed', '0') === '1',
  cmdOpen: false,
  setTheme: (theme) => {
    ls.set('af.theme', theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  setLang: (lang) => {
    ls.set('af.lang', lang);
    document.documentElement.setAttribute('lang', lang);
    set({ lang });
  },
  toggleCollapsed: () => {
    const collapsed = !get().collapsed;
    ls.set('af.collapsed', collapsed ? '1' : '0');
    set({ collapsed });
  },
  setCmdOpen: (cmdOpen) => set({ cmdOpen }),
}));

export const initTheme = (): void => applyTheme((ls.get('af.theme', 'dark') as Theme));
