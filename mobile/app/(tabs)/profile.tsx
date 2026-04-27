import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/hooks/useAuth';
import { api, type DispatchResource } from '@/lib/api';
import { PrimaryButton } from '@/components/PrimaryButton';

export default function ProfileScreen() {
  const colors = useColors();
  const {
    client,
    baseUrl,
    resourceId,
    resourceName,
    pushEnabled,
    pushSyncing,
    pushError,
    deviceSecret,
    signOut,
    setResource,
    setPushEnabled,
    pairDevice,
    unpairDevice,
  } = useAuth();
  const [showPicker, setShowPicker] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const resourcesQuery = useQuery({
    queryKey: ['resources'],
    enabled: client !== null,
    queryFn: () => api.listResources(client!),
  });

  const onSignOut = () => {
    Alert.alert('Sign out?', 'You will need to enter your API key again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          signOut();
        },
      },
    ]);
  };

  const onSelectResource = async (r: DispatchResource | null) => {
    if (r === null) {
      await setResource(null, null);
    } else {
      await setResource(r.id, r.name);
    }
    setShowPicker(false);
  };

  const onPair = async () => {
    setPairingError(null);
    setPairingBusy(true);
    try {
      const result = await pairDevice(pairingCode);
      setPairingCode('');
      Alert.alert(
        'Device paired',
        `Live location will be shared with dispatch only while you have an active job for ${result.resourceName}.`,
      );
    } catch (err) {
      setPairingError(
        err instanceof Error ? err.message : 'Pairing failed. Check the code and try again.',
      );
    } finally {
      setPairingBusy(false);
    }
  };

  const onUnpair = () => {
    Alert.alert(
      'Stop sharing location?',
      'You will need a new pairing code from your dispatcher to start sharing again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop sharing',
          style: 'destructive',
          onPress: () => {
            void unpairDevice();
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={styles.container}
    >
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
          Server
        </Text>
        <Text
          style={[styles.cardValue, { color: colors.text }]}
          numberOfLines={2}
        >
          {baseUrl ?? '—'}
        </Text>
      </View>

      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
          Technician (resource)
        </Text>
        <Text
          style={[styles.cardValue, { color: colors.text }]}
          numberOfLines={2}
        >
          {resourceName ?? 'All technicians'}
        </Text>
        <Text style={[styles.helper, { color: colors.textMuted }]}>
          Filters jobs and appointments to a specific technician.
        </Text>
        <Pressable
          onPress={() => setShowPicker((v) => !v)}
          style={({ pressed }) => [
            styles.linkBtn,
            { opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Ionicons name="people-outline" size={16} color={colors.primary} />
          <Text style={[styles.linkText, { color: colors.primary }]}>
            {showPicker ? 'Hide list' : 'Change technician'}
          </Text>
        </Pressable>

        {showPicker ? (
          <View style={styles.picker}>
            {resourcesQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} />
            ) : resourcesQuery.isError ? (
              <Text style={{ color: colors.danger }}>
                {resourcesQuery.error instanceof Error
                  ? resourcesQuery.error.message
                  : 'Failed to load technicians.'}
              </Text>
            ) : (
              <View style={{ gap: 8 }}>
                <ResourceRow
                  label="All technicians"
                  selected={resourceId === null}
                  onPress={() => onSelectResource(null)}
                />
                {(resourcesQuery.data?.resources ?? [])
                  .filter((r) => r.status === 'active')
                  .map((r) => (
                    <ResourceRow
                      key={r.id}
                      label={r.name}
                      sublabel={r.email ?? r.role ?? undefined}
                      selected={resourceId === r.id}
                      onPress={() => onSelectResource(r)}
                    />
                  ))}
              </View>
            )}
          </View>
        ) : null}
      </View>

      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
          Live location
        </Text>
        <Text style={[styles.cardValue, { color: colors.text }]}>
          {deviceSecret ? 'Sharing enabled' : 'Not paired'}
        </Text>
        <Text style={[styles.helper, { color: colors.textMuted }]}>
          Your dispatcher will issue a one-time pairing code. Once paired,
          this device shares your live GPS location with dispatch only while
          you have an active job (en route, on site, or in progress) — and
          stops automatically when the job is completed or cancelled.
        </Text>
        {deviceSecret ? (
          <PrimaryButton
            label="Stop sharing location"
            variant="danger"
            onPress={onUnpair}
            style={{ marginTop: 12 }}
          />
        ) : (
          <View style={{ marginTop: 12, gap: 8 }}>
            <TextInput
              value={pairingCode}
              onChangeText={(v) => setPairingCode(v.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={8}
              placeholder="XXXXXXXX"
              placeholderTextColor={colors.textMuted}
              style={[
                styles.codeInput,
                {
                  borderColor: colors.border,
                  color: colors.text,
                  backgroundColor: colors.background,
                },
              ]}
            />
            <PrimaryButton
              label={pairingBusy ? 'Pairing…' : 'Pair this device'}
              onPress={onPair}
              disabled={pairingBusy || pairingCode.trim().length !== 8}
            />
            {pairingError ? (
              <Text style={[styles.helper, { color: colors.danger }]}>
                {pairingError}
              </Text>
            ) : null}
          </View>
        )}
      </View>

      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.cardLabel, { color: colors.textMuted }]}>
              Notifications
            </Text>
            <Text style={[styles.cardValue, { color: colors.text }]}>
              Push alerts
            </Text>
            <Text style={[styles.helper, { color: colors.textMuted }]}>
              Get notified when a job is assigned to you, when its status moves
              to en route or on site, when a job is cancelled, or when an
              appointment is rescheduled or cancelled.
            </Text>
          </View>
          <Switch
            value={pushEnabled}
            onValueChange={(v) => {
              void setPushEnabled(v);
            }}
            disabled={pushSyncing}
          />
        </View>
        {pushSyncing ? (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={[styles.helper, { color: colors.textMuted }]}>
              Syncing device…
            </Text>
          </View>
        ) : null}
        {pushError ? (
          <Text
            style={[styles.helper, { color: colors.danger, marginTop: 8 }]}
          >
            {pushError}
          </Text>
        ) : null}
      </View>

      <PrimaryButton
        label="Sign out"
        variant="danger"
        onPress={onSignOut}
        style={{ marginTop: 12 }}
      />
    </ScrollView>
  );
}

function ResourceRow({
  label,
  sublabel,
  selected,
  onPress,
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.resourceRow,
        {
          backgroundColor: selected ? colors.primaryMuted : 'transparent',
          borderColor: selected ? colors.primary : colors.border,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.resourceName, { color: colors.text }]}>
          {label}
        </Text>
        {sublabel ? (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            {sublabel}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  card: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardValue: { fontSize: 16, fontWeight: '600', marginTop: 4 },
  helper: { fontSize: 12, marginTop: 4 },
  linkBtn: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  linkText: { fontWeight: '600' },
  picker: { marginTop: 12 },
  resourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  resourceName: { fontSize: 14, fontWeight: '600' },
  codeInput: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 6,
    textAlign: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 12,
    fontFamily: 'monospace',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  statusRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
