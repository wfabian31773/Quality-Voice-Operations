import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export interface PushRegistration {
  token: string;
  platform: 'ios' | 'android' | 'web';
}

let handlerConfigured = false;

function configureHandler(): void {
  if (handlerConfigured) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  handlerConfigured = true;
}

export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('dispatch', {
    name: 'Dispatch alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#0F172A',
    sound: 'default',
  });
}

function readProjectId(): string | undefined {
  const expoConfig = (Constants as unknown as {
    expoConfig?: { extra?: { eas?: { projectId?: string } } };
    easConfig?: { projectId?: string };
  }).expoConfig;
  const easConfig = (Constants as unknown as {
    easConfig?: { projectId?: string };
  }).easConfig;
  return (
    expoConfig?.extra?.eas?.projectId ?? easConfig?.projectId ?? undefined
  );
}

export async function registerForPushNotificationsAsync(): Promise<PushRegistration | null> {
  configureHandler();
  await ensureAndroidChannel();

  if (Platform.OS === 'web') {
    return null;
  }

  if (!Device.isDevice) {
    return null;
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== 'granted') {
    return null;
  }

  const projectId = readProjectId();
  const tokenResponse = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  const token = tokenResponse.data;
  if (!token) return null;

  return {
    token,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  };
}

export function getDeviceLabel(): string {
  const name = Device.deviceName ?? Device.modelName ?? 'Mobile device';
  return name.slice(0, 120);
}
