import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { STATUS_TONES, type AppColors } from '@/constants/colors';
import { formatStatus } from '@/lib/formatters';

interface StatusPillProps {
  status: string | null | undefined;
  size?: 'sm' | 'md';
}

export function StatusPill({ status, size = 'md' }: StatusPillProps) {
  const colors = useColors();
  const tone = STATUS_TONES[status ?? ''] ?? {
    fg: 'textMuted' as keyof AppColors,
    bg: 'surfaceMuted' as keyof AppColors,
  };
  const fg = colors[tone.fg];
  const bg = colors[tone.bg];

  return (
    <View
      style={[
        styles.pill,
        size === 'sm' && styles.pillSm,
        { backgroundColor: bg },
      ]}
    >
      <Text
        style={[
          styles.label,
          size === 'sm' && styles.labelSm,
          { color: fg },
        ]}
      >
        {formatStatus(status) || '—'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  pillSm: {
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  labelSm: {
    fontSize: 11,
  },
});
