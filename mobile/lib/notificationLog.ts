import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  deserializeLog,
  serializeLog,
  type NotificationRecord,
} from '../../shared/notifications/inbox';

const STORAGE_KEY = 'voiceai.tech.notificationLog';

export async function loadStoredNotifications(): Promise<NotificationRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return deserializeLog(raw);
  } catch {
    return [];
  }
}

export async function saveStoredNotifications(
  log: NotificationRecord[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, serializeLog(log));
  } catch {
    // best-effort persistence; in-memory state remains the source of truth
  }
}

export async function clearStoredNotifications(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
