import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useColors } from '@/hooks/useColors';

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function PrimaryButton({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  testID,
}: PrimaryButtonProps) {
  const colors = useColors();
  const isDisabled = disabled || loading;

  const palette: Record<
    NonNullable<PrimaryButtonProps['variant']>,
    { bg: string; fg: string; border?: string }
  > = {
    primary: { bg: colors.primary, fg: colors.textInverse },
    secondary: {
      bg: colors.surfaceMuted,
      fg: colors.text,
      border: colors.border,
    },
    danger: { bg: colors.danger, fg: '#FFFFFF' },
    success: { bg: colors.success, fg: '#FFFFFF' },
    ghost: { bg: 'transparent', fg: colors.primary },
  };
  const tone = palette[variant];

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: tone.bg,
          borderColor: tone.border ?? 'transparent',
          borderWidth: tone.border ? 1 : 0,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={tone.fg} />
      ) : (
        <Text style={[styles.label, { color: tone.fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
});
