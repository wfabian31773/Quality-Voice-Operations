import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/hooks/useAuth';
import {
  api,
  ApiError,
  OfflineError,
  type DispatchTransition,
} from '@/lib/api';
import { isOffline } from '@/lib/connectivity';
import {
  enqueueJobAttachmentNote,
  enqueueJobAttachmentPhoto,
} from '@/lib/offlineQueue';
import { persistAttachmentForUpload } from '@/lib/attachmentStorage';
import { PrimaryButton } from '@/components/PrimaryButton';

interface PendingPhoto {
  uri: string;
  mimeType: string;
  fileSize: number | null;
  attachmentType: 'photo' | 'proof_of_completion';
}

interface CompletionSheetProps {
  visible: boolean;
  jobId: string;
  jobTitle?: string | null;
  jobStatus: string;
  onClose: () => void;
  onCompleted: () => void;
}

const NEXT_TRANSITIONS: Record<string, DispatchTransition | null> = {
  pending: null,
  assigned: null,
  scheduled: null,
  en_route: null,
  on_site: null,
  in_progress: 'completed',
  completed: null,
  done: null,
  incomplete: null,
  cancelled: null,
};

function isLikelyNetworkError(err: unknown): boolean {
  if (err instanceof OfflineError) return true;
  if (err instanceof ApiError) return false;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('network request failed') ||
      msg.includes('failed to fetch') ||
      msg.includes('load failed') ||
      msg.includes('network error') ||
      msg.includes('timed out')
    );
  }
  return false;
}

export function CompletionSheet({
  visible,
  jobId,
  jobTitle,
  jobStatus,
  onClose,
  onCompleted,
}: CompletionSheetProps) {
  const colors = useColors();
  const { client } = useAuth();
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [markComplete, setMarkComplete] = useState(true);

  const canMarkComplete = NEXT_TRANSITIONS[jobStatus] !== null;

  const reset = () => {
    setNote('');
    setPhotos([]);
    setProgress(null);
    setMarkComplete(true);
  };

  const closeAndReset = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const pickFromCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Camera permission needed',
        'Allow camera access in settings to attach a photo.',
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.7,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      exif: false,
    });
    addAssets(result, 'proof_of_completion');
  };

  const pickFromLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Photo library permission needed',
        'Allow photo library access in settings to attach photos.',
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.7,
      allowsMultipleSelection: true,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      exif: false,
      selectionLimit: 6,
    });
    addAssets(result, 'photo');
  };

  const addAssets = (
    result: ImagePicker.ImagePickerResult,
    attachmentType: PendingPhoto['attachmentType'],
  ) => {
    if (result.canceled) return;
    const next = result.assets.map((a) => ({
      uri: a.uri,
      mimeType: a.mimeType ?? 'image/jpeg',
      fileSize: a.fileSize ?? null,
      attachmentType,
    }));
    setPhotos((prev) => [...prev, ...next]);
  };

  const removePhoto = (uri: string) => {
    setPhotos((prev) => prev.filter((p) => p.uri !== uri));
  };

  const trimmedNote = note.trim();
  const canSubmit =
    !submitting && (trimmedNote.length > 0 || photos.length > 0);

  const titleForPhoto = (
    photo: PendingPhoto,
    index: number,
  ): string => {
    const prefix =
      photo.attachmentType === 'proof_of_completion'
        ? 'Proof of completion'
        : 'Field photo';
    return `${prefix} ${index + 1}`;
  };

  const queueRemaining = async (
    pendingPhotos: { photo: PendingPhoto; index: number }[],
    pendingNote: string | null,
    completionTransition: DispatchTransition | null,
  ): Promise<void> => {
    const willHaveNote = pendingNote !== null && pendingNote.length > 0;
    for (let i = 0; i < pendingPhotos.length; i++) {
      const { photo, index } = pendingPhotos[i];
      setProgress(`Saving photo ${i + 1} of ${pendingPhotos.length} for later…`);
      const isLast = i === pendingPhotos.length - 1;
      const transitionForCall =
        isLast && !willHaveNote ? completionTransition : null;
      const enqueueId = `${jobId}_${Date.now()}_${index}`;
      const localUri = await persistAttachmentForUpload(
        photo.uri,
        photo.mimeType,
        enqueueId,
      );
      await enqueueJobAttachmentPhoto({
        jobId,
        jobTitle: jobTitle ?? null,
        attachmentType: photo.attachmentType,
        title: titleForPhoto(photo, index),
        localFileUri: localUri,
        mimeType: photo.mimeType,
        fileSizeBytes: photo.fileSize,
        completionTransition: transitionForCall,
      });
    }
    if (willHaveNote) {
      setProgress('Saving note for later…');
      await enqueueJobAttachmentNote({
        jobId,
        jobTitle: jobTitle ?? null,
        title: 'Completion note',
        content: pendingNote!,
        completionTransition,
      });
    }
  };

  const submit = async () => {
    if (!client || !canSubmit) return;
    setSubmitting(true);
    setProgress('Preparing upload…');

    const completionTransition: DispatchTransition | null =
      markComplete && canMarkComplete ? NEXT_TRANSITIONS[jobStatus] : null;

    try {
      // If the device is already known to be offline, skip the network
      // round-trip entirely and persist everything to the local queue. The
      // background runner will pick it up the next time we have connectivity.
      if (isOffline()) {
        const pending = photos.map((photo, index) => ({ photo, index }));
        await queueRemaining(
          pending,
          trimmedNote.length > 0 ? trimmedNote : null,
          completionTransition,
        );
        setProgress(null);
        setSubmitting(false);
        reset();
        Alert.alert(
          'Saved offline',
          completionTransition
            ? 'Your photos, notes, and completion will sync as soon as you’re back online.'
            : 'Your photos and notes will sync as soon as you’re back online.',
        );
        onCompleted();
        onClose();
        return;
      }

      const totalPhotos = photos.length;
      const willHaveNote = trimmedNote.length > 0;

      for (let i = 0; i < totalPhotos; i++) {
        const photo = photos[i];
        setProgress(`Uploading photo ${i + 1} of ${totalPhotos}…`);
        const isLast = i === totalPhotos - 1;
        const transitionForCall =
          isLast && !willHaveNote ? completionTransition : null;
        try {
          const ticket = await api.requestAttachmentUpload(client, {
            mime_type: photo.mimeType,
            size_bytes: photo.fileSize ?? undefined,
          });
          await api.uploadAttachmentBinary(ticket, {
            uri: photo.uri,
            mimeType: photo.mimeType,
            sizeBytes: photo.fileSize,
          });
          await api.addAttachment(client, jobId, {
            attachment_type: photo.attachmentType,
            title: titleForPhoto(photo, i),
            object_path: ticket.objectPath,
            mime_type: photo.mimeType,
            file_size_bytes: photo.fileSize,
            completion_transition: transitionForCall,
          });
        } catch (err) {
          if (!isLikelyNetworkError(err)) throw err;
          // Connectivity blip — persist this photo and everything after it,
          // including the note + completion transition, then exit cleanly.
          const remainingPhotos = photos
            .slice(i)
            .map((p, idx) => ({ photo: p, index: i + idx }));
          await queueRemaining(
            remainingPhotos,
            willHaveNote ? trimmedNote : null,
            completionTransition,
          );
          setProgress(null);
          setSubmitting(false);
          reset();
          Alert.alert(
            'Saved offline',
            'We lost the connection mid-upload — the rest will sync as soon as you’re back online.',
          );
          onCompleted();
          onClose();
          return;
        }
      }

      if (willHaveNote) {
        setProgress('Saving note…');
        try {
          await api.addAttachment(client, jobId, {
            attachment_type: 'note',
            title: 'Completion note',
            content: trimmedNote,
            completion_transition: completionTransition,
          });
        } catch (err) {
          if (!isLikelyNetworkError(err)) throw err;
          await queueRemaining([], trimmedNote, completionTransition);
          setProgress(null);
          setSubmitting(false);
          reset();
          Alert.alert(
            'Saved offline',
            'We lost the connection — your note will sync as soon as you’re back online.',
          );
          onCompleted();
          onClose();
          return;
        }
      }

      setProgress(null);
      setSubmitting(false);
      reset();
      onCompleted();
      onClose();
    } catch (err) {
      setSubmitting(false);
      setProgress(null);
      const message =
        err instanceof ApiError ? err.message : 'Could not save your update.';
      Alert.alert('Upload failed', message);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={closeAndReset}
    >
      <View style={[styles.flex, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderColor: colors.border }]}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            {canMarkComplete ? 'Complete with photos & notes' : 'Add update'}
          </Text>
          <Pressable
            onPress={closeAndReset}
            hitSlop={12}
            disabled={submitting}
            accessibilityLabel="Close"
          >
            <Ionicons
              name="close"
              size={24}
              color={submitting ? colors.textMuted : colors.text}
            />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.label, { color: colors.textMuted }]}>
            Photos
          </Text>
          <View style={styles.photoGrid}>
            {photos.map((p) => (
              <View
                key={p.uri}
                style={[styles.photoTile, { borderColor: colors.border }]}
              >
                <Image source={{ uri: p.uri }} style={styles.photoImage} />
                <Pressable
                  onPress={() => removePhoto(p.uri)}
                  style={styles.photoRemove}
                  hitSlop={8}
                  disabled={submitting}
                  accessibilityLabel="Remove photo"
                >
                  <Ionicons name="close" size={14} color="#fff" />
                </Pressable>
              </View>
            ))}
            <View style={styles.photoActions}>
              <Pressable
                onPress={pickFromCamera}
                disabled={submitting}
                style={({ pressed }) => [
                  styles.photoButton,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Ionicons name="camera-outline" size={20} color={colors.text} />
                <Text style={[styles.photoButtonLabel, { color: colors.text }]}>
                  Take photo
                </Text>
              </Pressable>
              <Pressable
                onPress={pickFromLibrary}
                disabled={submitting}
                style={({ pressed }) => [
                  styles.photoButton,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.border,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Ionicons name="images-outline" size={20} color={colors.text} />
                <Text style={[styles.photoButtonLabel, { color: colors.text }]}>
                  From library
                </Text>
              </Pressable>
            </View>
          </View>

          <Text
            style={[styles.label, { color: colors.textMuted, marginTop: 24 }]}
          >
            Notes
          </Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What did you do? Anything the office needs to know?"
            placeholderTextColor={colors.textMuted}
            multiline
            numberOfLines={Platform.OS === 'ios' ? undefined : 6}
            style={[
              styles.notesInput,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            editable={!submitting}
          />

          {canMarkComplete ? (
            <Pressable
              onPress={() => setMarkComplete((v) => !v)}
              disabled={submitting}
              style={[styles.toggleRow, { borderColor: colors.border }]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: markComplete }}
            >
              <Ionicons
                name={
                  markComplete ? 'checkbox-outline' : 'square-outline'
                }
                size={20}
                color={markComplete ? colors.primary : colors.textMuted}
              />
              <Text style={[styles.toggleLabel, { color: colors.text }]}>
                Mark job complete after upload
              </Text>
            </Pressable>
          ) : null}

          {progress ? (
            <View style={styles.progressRow}>
              <ActivityIndicator color={colors.primary} />
              <Text style={{ color: colors.textMuted, marginLeft: 8 }}>
                {progress}
              </Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.footer, { borderColor: colors.border }]}>
          <PrimaryButton
            label="Cancel"
            variant="secondary"
            onPress={closeAndReset}
            disabled={submitting}
            style={{ flex: 1, marginRight: 8 }}
          />
          <PrimaryButton
            label={
              markComplete && canMarkComplete
                ? 'Save & complete'
                : 'Save update'
            }
            variant="success"
            onPress={submit}
            loading={submitting}
            disabled={!canSubmit}
            style={{ flex: 1, marginLeft: 8 }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  body: { padding: 16, paddingBottom: 32 },
  label: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  photoTile: {
    width: 88,
    height: 88,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  photoImage: { width: '100%', height: '100%' },
  photoRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoActions: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
  },
  photoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  photoButtonLabel: { fontSize: 13, fontWeight: '600' },
  notesInput: {
    minHeight: 110,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 16,
  },
  toggleLabel: { fontSize: 14, fontWeight: '500' },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderTopWidth: 1,
  },
});
