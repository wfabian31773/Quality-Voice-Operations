import * as FileSystem from 'expo-file-system';

const QUEUE_DIR_NAME = 'offline-attachments';

function queueDir(): string | null {
  if (!FileSystem.documentDirectory) return null;
  return `${FileSystem.documentDirectory}${QUEUE_DIR_NAME}/`;
}

async function ensureQueueDir(): Promise<string | null> {
  const dir = queueDir();
  if (!dir) return null;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  } catch {
    return null;
  }
  return dir;
}

function extensionForMime(mime: string | null | undefined): string {
  if (!mime) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('heic')) return 'heic';
  if (mime.includes('heif')) return 'heif';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

/**
 * Copy a transient picker URI (cache-backed on iOS) into the app's document
 * directory so the queued upload survives app restarts and OS cache eviction.
 * Returns the original URI on platforms without a documentDirectory (e.g.
 * web), where transient picker URIs are typically blob URLs that can't be
 * persisted anyway.
 */
export async function persistAttachmentForUpload(
  sourceUri: string,
  mimeType: string | null | undefined,
  id: string,
): Promise<string> {
  const dir = await ensureQueueDir();
  if (!dir) return sourceUri;
  const ext = extensionForMime(mimeType);
  const dest = `${dir}${id}.${ext}`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    return dest;
  } catch {
    // Fall back to the source URI rather than failing the enqueue. The
    // upload runner will still try; worst case we surface a real error
    // when the temp file is gone.
    return sourceUri;
  }
}

export async function deletePersistedAttachment(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  const dir = queueDir();
  if (!dir || !uri.startsWith(dir)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Remove any persisted attachment files that aren't referenced by the
 * provided set of live URIs. Safe to call periodically (e.g. on app start)
 * to avoid leaking storage when entries get dropped or the app is
 * force-quit mid-drain.
 */
export async function pruneOrphanedAttachments(liveUris: Set<string>): Promise<void> {
  const dir = queueDir();
  if (!dir) return;
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) return;
    const entries = await FileSystem.readDirectoryAsync(dir);
    await Promise.all(
      entries.map(async (name) => {
        const full = `${dir}${name}`;
        if (liveUris.has(full)) return;
        try {
          await FileSystem.deleteAsync(full, { idempotent: true });
        } catch {
          // best-effort
        }
      }),
    );
  } catch {
    // best-effort
  }
}
