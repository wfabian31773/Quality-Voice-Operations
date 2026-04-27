import { useColorScheme } from 'react-native';
import { lightColors, darkColors, type AppColors } from '@/constants/colors';

export function useColors(): AppColors {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkColors : lightColors;
}
