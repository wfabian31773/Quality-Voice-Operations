import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';

interface ContactRowProps {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export function ContactRow({ name, phone, email }: ContactRowProps) {
  const colors = useColors();

  if (!name && !phone && !email) return null;

  const callPhone = () => {
    if (!phone) return;
    const sanitized = phone.replace(/\s+/g, '');
    const scheme = Platform.OS === 'android' ? 'tel:' : 'telprompt:';
    Linking.openURL(`${scheme}${sanitized}`).catch(() => {
      Linking.openURL(`tel:${sanitized}`).catch(() => undefined);
    });
  };

  const sendSms = () => {
    if (!phone) return;
    const sanitized = phone.replace(/\s+/g, '');
    Linking.openURL(`sms:${sanitized}`).catch(() => undefined);
  };

  const sendEmail = () => {
    if (!email) return;
    Linking.openURL(`mailto:${email}`).catch(() => undefined);
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.label, { color: colors.textMuted }]}>Customer</Text>
      <Text style={[styles.name, { color: colors.text }]}>
        {name ?? 'Unknown contact'}
      </Text>
      {phone ? (
        <Text style={[styles.detail, { color: colors.textMuted }]}>{phone}</Text>
      ) : null}
      {email ? (
        <Text style={[styles.detail, { color: colors.textMuted }]}>{email}</Text>
      ) : null}

      <View style={styles.actions}>
        {phone ? (
          <Pressable
            onPress={callPhone}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Ionicons name="call" size={16} color="#fff" />
            <Text style={styles.actionText}>Call</Text>
          </Pressable>
        ) : null}
        {phone ? (
          <Pressable
            onPress={sendSms}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: colors.info, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Ionicons name="chatbubble-ellipses" size={16} color="#fff" />
            <Text style={styles.actionText}>Text</Text>
          </Pressable>
        ) : null}
        {email ? (
          <Pressable
            onPress={sendEmail}
            style={({ pressed }) => [
              styles.actionBtn,
              {
                backgroundColor: colors.surfaceMuted,
                borderWidth: 1,
                borderColor: colors.border,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <Ionicons name="mail" size={16} color={colors.text} />
            <Text style={[styles.actionText, { color: colors.text }]}>
              Email
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  name: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 4,
  },
  detail: {
    fontSize: 14,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  actionText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
});
