import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/hooks/useAuth';
import { PrimaryButton } from '@/components/PrimaryButton';
import { api, getDefaultApiUrl, ApiError } from '@/lib/api';

export default function LoginScreen() {
  const colors = useColors();
  const { signIn } = useAuth();
  const [baseUrl, setBaseUrl] = useState(getDefaultApiUrl());
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedKey = apiKey.trim();
  const trimmedUrl = baseUrl.trim().replace(/\/+$/, '');
  const isValidKey = trimmedKey.startsWith('vai_');
  const canSubmit =
    !submitting && trimmedUrl.length > 0 && isValidKey;

  const onSubmit = async () => {
    setError(null);
    if (!canSubmit) {
      setError('API key must start with "vai_".');
      return;
    }
    setSubmitting(true);
    try {
      await api.listJobs(
        { baseUrl: trimmedUrl, apiKey: trimmedKey },
        { limit: 1 },
      );
      await signIn({
        baseUrl: trimmedUrl,
        apiKey: trimmedKey,
        resourceId: null,
        resourceName: null,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          setError('Invalid API key or insufficient permissions.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Could not reach the server. Check the URL and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>
              Voice AI Tech
            </Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>
              Sign in with your dispatch API key to view assigned jobs and
              upcoming appointments.
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.text }]}>
              Server URL
            </Text>
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://your-tenant.example.com"
              placeholderTextColor={colors.textMuted}
              style={[
                styles.input,
                {
                  color: colors.text,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                },
              ]}
            />
          </View>

          <View style={styles.field}>
            <Text style={[styles.label, { color: colors.text }]}>API Key</Text>
            <TextInput
              value={apiKey}
              onChangeText={setApiKey}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="vai_..."
              placeholderTextColor={colors.textMuted}
              style={[
                styles.input,
                {
                  color: colors.text,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                },
              ]}
            />
            <Text style={[styles.hint, { color: colors.textMuted }]}>
              Generate one in the admin console under Settings → API Keys.
            </Text>
          </View>

          {error ? (
            <View
              style={[
                styles.errorBox,
                {
                  backgroundColor: colors.dangerMuted,
                  borderColor: colors.danger,
                },
              ]}
            >
              <Text style={{ color: colors.danger }}>{error}</Text>
            </View>
          ) : null}

          <PrimaryButton
            label="Sign In"
            onPress={onSubmit}
            loading={submitting}
            disabled={!canSubmit}
            style={{ marginTop: 8 }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  scroll: {
    padding: 24,
    gap: 16,
    flexGrow: 1,
    justifyContent: 'center',
  },
  header: { marginBottom: 16, gap: 8 },
  title: { fontSize: 28, fontWeight: '800' },
  subtitle: { fontSize: 15, lineHeight: 22 },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  hint: { fontSize: 12 },
  errorBox: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
});
