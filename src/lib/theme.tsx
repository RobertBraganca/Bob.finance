import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Surface } from './chartTheme'

export type AppTheme = 'light' | 'dark'

const STORAGE_KEY = 'app-theme'

type ThemeContextValue = {
  theme: AppTheme
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function readInitialTheme(): AppTheme {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'dark' ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<AppTheme>(readInitialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    // `tokens.css` keys off `data-theme` above; the `dark` class is only
    // for shadcn/Tailwind components that reach for a `dark:` variant
    // directly instead of one of this app's own colour tokens.
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(STORAGE_KEY, theme)
  }, [theme])

  const toggle = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme precisa estar dentro de ThemeProvider')
  return context
}

/**
 * Charts pick a colour set by declaring which surface they sit on — but
 * that palette was only ever validated for TWO fixed backgrounds (paper
 * #ffffff, slab #080808). In dark mode `.card` visually becomes as dark
 * as `.slab`, so a chart asking for "paper" would otherwise render
 * light-tuned grid/axis colours on a now-dark background. Remapping
 * every "paper" request to "slab" while dark mode is on reuses the
 * already-calibrated palette instead of inventing a third one.
 */
export function useEffectiveSurface(preferred: Surface): Surface {
  const { theme } = useTheme()
  return theme === 'dark' ? 'slab' : preferred
}
