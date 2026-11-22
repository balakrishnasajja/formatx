import { useEffect, useState } from 'react';
import { resolveEditorTheme } from '../components/Editor/themes';
import { useAppStore } from './useAppStore';

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'undefined' ? true : !matchMedia('(prefers-color-scheme: light)').matches;
}

/** Resolved app theme ('dark' | 'light'), following the OS when set to 'system'. */
export function useResolvedTheme(): 'dark' | 'light' {
  const setting = useAppStore((s) => s.settings.appTheme);
  const [sys, setSys] = useState(systemPrefersDark);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const on = () => setSys(!mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return setting === 'system' ? (sys ? 'dark' : 'light') : setting;
}

export function useApplyTheme(): void {
  const theme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
}

export function useEditorTheme(): string {
  const setting = useAppStore((s) => s.settings.editorTheme);
  const theme = useResolvedTheme();
  return resolveEditorTheme(setting, theme === 'dark');
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof matchMedia === 'undefined' ? false : matchMedia(query).matches));
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}
