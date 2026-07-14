import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** What the user picked. 'system' follows the OS setting live. */
export type ThemePref = 'light' | 'dark' | 'system';
/** What actually gets painted — 'system' is resolved to one of these. */
type Resolved = 'light' | 'dark';

// Kept in sync with the inline bootstrap in index.html, which sets data-theme
// before React mounts so there is no flash of the wrong theme on load.
const KEY = 'vfw-theme';

const mql = () => window.matchMedia('(prefers-color-scheme: dark)');
const systemDark = () => mql().matches;
const resolve = (pref: ThemePref): Resolved =>
  pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref;

function readPref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function apply(resolved: Resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
}

interface ThemeValue {
  /** The stored preference, including 'system'. */
  theme: ThemePref;
  /** The theme actually in effect right now. */
  resolved: Resolved;
  setTheme: (t: ThemePref) => void;
}

const Ctx = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePref>(readPref);
  const [resolved, setResolved] = useState<Resolved>(() => resolve(readPref()));

  // Persist the choice and paint it whenever the preference changes.
  useEffect(() => {
    const r = resolve(theme);
    setResolved(r);
    apply(r);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  // While on 'system', track the OS flipping between light and dark.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = mql();
    const onChange = () => {
      const r: Resolved = mq.matches ? 'dark' : 'light';
      setResolved(r);
      apply(r);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  return (
    <Ctx.Provider value={{ theme, resolved, setTheme: setThemeState }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
