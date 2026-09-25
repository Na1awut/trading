import { DarkTheme, type Theme } from 'expo-router';

export const colors = {
  background: '#0B0E14',
  card: '#121722',
  cardRaised: '#171D2A',
  border: '#1F2733',
  text: '#F3F5F8',
  textMuted: '#8A94A6',
  textFaint: '#5B6475',
  positive: '#22C55E',
  positiveBg: 'rgba(34,197,94,0.14)',
  negative: '#EF4444',
  negativeBg: 'rgba(239,68,68,0.14)',
  accent: '#3B82F6',
  warning: '#F59E0B',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const navTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
    border: colors.border,
    text: colors.text,
    primary: colors.accent,
  },
};
