import type { Config } from 'tailwindcss';

const withAlpha = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: withAlpha('--bg'),
        surface: withAlpha('--surface'),
        card: withAlpha('--card'),
        elevated: withAlpha('--elevated'),
        border: withAlpha('--border'),
        'border-strong': withAlpha('--border-strong'),
        muted: withAlpha('--muted'),
        primary: {
          DEFAULT: withAlpha('--primary'),
          strong: withAlpha('--primary-strong'),
        },
        secondary: withAlpha('--secondary'),
        accent: withAlpha('--accent'),
        success: withAlpha('--success'),
        warning: withAlpha('--warning'),
        danger: withAlpha('--danger'),
        'txt-primary': withAlpha('--text-primary'),
        'txt-secondary': withAlpha('--text-secondary'),
        'txt-disabled': withAlpha('--text-disabled'),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        lg: '10px',
        xl: '14px',
        '2xl': '18px',
      },
      boxShadow: {
        subtle: '0 1px 2px rgb(var(--shadow-color) / 0.06), 0 1px 3px rgb(var(--shadow-color) / 0.1)',
        card: '0 4px 16px rgb(var(--shadow-color) / 0.12)',
        pop: '0 12px 40px rgb(var(--shadow-color) / 0.28)',
        glow: '0 0 0 1px rgb(var(--primary) / 0.4), 0 8px 30px rgb(var(--primary) / 0.15)',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
