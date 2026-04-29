import { useEffect, useRef } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { useColorScheme, View } from 'react-native';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { NotificationLogProvider } from '@/hooks/useNotificationLog';
import { queryClient } from '@/lib/queryClient';
import { LoadingView } from '@/components/LoadingView';
import { OfflineBanner } from '@/components/OfflineBanner';
import { LocationTrackingGate } from '@/components/LocationTrackingGate';
import { useColors } from '@/hooks/useColors';
import {
  readLastHandledPushId,
  writeLastHandledPushId,
} from '@/lib/auth';
import {
  notificationTargetPath,
  processColdStartResponse,
} from '../../shared/notifications/deepLink';

function AuthGate({ children }: { children: React.ReactNode }) {
  const { ready, signedIn } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const colors = useColors();
  const pendingDeepLink = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const inAuth = segments[0] === '(auth)';
    if (!signedIn && !inAuth) {
      router.replace('/(auth)/login');
      return;
    }
    if (signedIn && inAuth) {
      router.replace('/(tabs)/dispatch');
      return;
    }
    // Once we're signed in and out of the auth stack, drain any push-tap
    // deep-link that arrived before the navigator was ready.
    if (signedIn && pendingDeepLink.current) {
      const target = pendingDeepLink.current;
      pendingDeepLink.current = null;
      router.push(target);
    }
  }, [ready, signedIn, segments, router]);

  const navStateRef = useRef({ ready, signedIn });
  navStateRef.current = { ready, signedIn };

  useEffect(() => {
    let cancelled = false;
    const route = (path: string | null) => {
      if (!path) return;
      const { ready: r, signedIn: s } = navStateRef.current;
      if (!r || !s) {
        pendingDeepLink.current = path;
        return;
      }
      router.push(path);
    };

    // Cold-start: act on the launching notification only the first time we
    // see its id, so subsequent app launches don't replay the same deep-link.
    Notifications.getLastNotificationResponseAsync()
      .then(async (resp) => {
        if (cancelled) return;
        const result = await processColdStartResponse(resp, {
          readLastHandledPushId,
          writeLastHandledPushId,
        });
        route(result.path);
      })
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const id = resp.notification?.request?.identifier ?? null;
      if (id) void writeLastHandledPushId(id);
      const data = resp.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      route(notificationTargetPath(data));
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <LoadingView />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <OfflineBanner />
      {signedIn ? <LocationTrackingGate /> : null}
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
            <NotificationLogProvider>
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
            </NotificationLogProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
