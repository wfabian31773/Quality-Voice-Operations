import { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { useColorScheme, View } from 'react-native';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { queryClient } from '@/lib/queryClient';
import { LoadingView } from '@/components/LoadingView';
import { OfflineBanner } from '@/components/OfflineBanner';
import { useColors } from '@/hooks/useColors';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { ready, signedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const colors = useColors();

  useEffect(() => {
    if (!ready) return;
    const inAuth = segments[0] === '(auth)';
    if (!signedIn && !inAuth) {
      router.replace('/(auth)/login');
    } else if (signedIn && inAuth) {
      router.replace('/(tabs)/dispatch');
    }
  }, [ready, signedIn, segments, router]);

  if (!ready) return <LoadingView />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <OfflineBanner />
      {children}
    </View>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AuthGate>
              <Stack
                screenOptions={{
                  headerShadowVisible: false,
                  contentStyle: {
                    backgroundColor:
                      scheme === 'dark' ? '#020617' : '#F8FAFC',
                  },
                }}
              >
                <Stack.Screen
                  name="(auth)"
                  options={{ headerShown: false }}
                />
                <Stack.Screen
                  name="(tabs)"
                  options={{ headerShown: false }}
                />
                <Stack.Screen
                  name="jobs/[id]"
                  options={{ title: 'Job Details', presentation: 'card' }}
                />
                <Stack.Screen
                  name="bookings/[id]"
                  options={{ title: 'Appointment', presentation: 'card' }}
                />
              </Stack>
              <StatusBar style="auto" />
            </AuthGate>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
