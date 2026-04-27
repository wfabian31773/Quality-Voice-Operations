export interface AppColors {
  background: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  divider: string;
  text: string;
  textMuted: string;
  textInverse: string;
  primary: string;
  primaryMuted: string;
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;
  info: string;
  infoMuted: string;
}

export const lightColors: AppColors = {
  background: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceMuted: '#F1F5F9',
  border: '#E2E8F0',
  divider: '#E5E7EB',
  text: '#0F172A',
  textMuted: '#64748B',
  textInverse: '#FFFFFF',
  primary: '#2563EB',
  primaryMuted: '#DBEAFE',
  success: '#16A34A',
  successMuted: '#DCFCE7',
  warning: '#D97706',
  warningMuted: '#FEF3C7',
  danger: '#DC2626',
  dangerMuted: '#FEE2E2',
  info: '#0EA5E9',
  infoMuted: '#E0F2FE',
};

export const darkColors: AppColors = {
  background: '#020617',
  surface: '#0F172A',
  surfaceMuted: '#1E293B',
  border: '#1E293B',
  divider: '#1F2937',
  text: '#F8FAFC',
  textMuted: '#94A3B8',
  textInverse: '#0F172A',
  primary: '#3B82F6',
  primaryMuted: '#1E3A8A',
  success: '#22C55E',
  successMuted: '#14532D',
  warning: '#F59E0B',
  warningMuted: '#78350F',
  danger: '#EF4444',
  dangerMuted: '#7F1D1D',
  info: '#38BDF8',
  infoMuted: '#075985',
};

export const STATUS_TONES: Record<
  string,
  { fg: keyof AppColors; bg: keyof AppColors }
> = {
  pending: { fg: 'textMuted', bg: 'surfaceMuted' },
  assigned: { fg: 'info', bg: 'infoMuted' },
  scheduled: { fg: 'info', bg: 'infoMuted' },
  en_route: { fg: 'warning', bg: 'warningMuted' },
  on_site: { fg: 'warning', bg: 'warningMuted' },
  in_progress: { fg: 'primary', bg: 'primaryMuted' },
  completed: { fg: 'success', bg: 'successMuted' },
  done: { fg: 'success', bg: 'successMuted' },
  cancelled: { fg: 'danger', bg: 'dangerMuted' },
  incomplete: { fg: 'danger', bg: 'dangerMuted' },
  confirmed: { fg: 'info', bg: 'infoMuted' },
  checked_in: { fg: 'warning', bg: 'warningMuted' },
  no_show: { fg: 'danger', bg: 'dangerMuted' },
  rescheduled: { fg: 'textMuted', bg: 'surfaceMuted' },
};
