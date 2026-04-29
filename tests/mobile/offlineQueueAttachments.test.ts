import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Native module mocks ----
const memoryStore = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (memoryStore.has(k) ? memoryStore.get(k)! : null),
    setItem: async (k: string, v: string) => {
      memoryStore.set(k, v);
    },
    removeItem: async (k: string) => {
      memoryStore.delete(k);
    },
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

vi.mock('expo-file-system', () => ({
  documentDirectory: '/tmp/test-doc/',
  getInfoAsync: async () => ({ exists: true }),
  makeDirectoryAsync: async () => undefined,
  readDirectoryAsync: async () => [],
  copyAsync: async () => undefined,
  deleteAsync: async () => undefined,
}));

const credsRef = { current: { baseUrl: 'http://api', apiKey: 'k1' } as { baseUrl: string; apiKey: string } | null };
vi.mock('../../mobile/lib/auth', () => ({
  loadStoredCredentials: async () => credsRef.current,
}));

const apiCalls: Array<{ name: string; args: unknown[] }> = [];
let nextRequestUploadImpl: () => Promise<{ uploadURL: string; objectPath: string }> = async () => ({
  uploadURL: 'http://put',
  objectPath: 'uploads/abc',
});
let nextUploadBinaryImpl: () => Promise<void> = async () => undefined;
let nextAddAttachmentImpl: () => Promise<unknown> = async () => ({ attachment: { id: 'a1' } });
let nextTransitionJobImpl: () => Promise<unknown> = async () => ({ job: { id: 'j' } });

vi.mock('../../mobile/lib/api', async () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  class OfflineError extends Error {
    constructor(msg = 'No network connection') {
      super(msg);
      this.name = 'OfflineError';
    }
  }
  return {
    ApiError,
    OfflineError,
    api: {
      requestAttachmentUpload: (...args: unknown[]) => {
        apiCalls.push({ name: 'requestAttachmentUpload', args });
        return nextRequestUploadImpl();
      },
      uploadAttachmentBinary: (...args: unknown[]) => {
        apiCalls.push({ name: 'uploadAttachmentBinary', args });
        return nextUploadBinaryImpl();
      },
      addAttachment: (...args: unknown[]) => {
        apiCalls.push({ name: 'addAttachment', args });
        return nextAddAttachmentImpl();
      },
      transitionJob: (...args: unknown[]) => {
        apiCalls.push({ name: 'transitionJob', args });
        return nextTransitionJobImpl();
      },
      transitionBooking: () => Promise.resolve(),
    },
  };
});

vi.mock('../../mobile/lib/connectivity', () => ({
  markOnline: () => undefined,
  subscribeConnectivity: () => () => undefined,
}));

// ---- Tests ----
describe('offlineQueue job_attachment kind', () => {
  beforeEach(async () => {
    memoryStore.clear();
    apiCalls.length = 0;
    nextRequestUploadImpl = async () => ({ uploadURL: 'http://put', objectPath: 'uploads/abc' });
    nextUploadBinaryImpl = async () => undefined;
    nextAddAttachmentImpl = async () => ({ attachment: { id: 'a1' } });
    nextTransitionJobImpl = async () => ({ job: { id: 'j' } });
    credsRef.current = { baseUrl: 'http://api', apiKey: 'k1' };
    const mod = await import('../../mobile/lib/offlineQueue');
    mod.__resetOfflineQueueForTests();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('summarises queued photos, notes, and a pending transition for a job', async () => {
    const queue = await import('../../mobile/lib/offlineQueue');
    await queue.enqueueJobAttachmentPhoto({
      jobId: 'job-1',
      jobTitle: 'Fix sink',
      attachmentType: 'proof_of_completion',
      title: 'Proof 1',
      localFileUri: 'file:///a.jpg',
      mimeType: 'image/jpeg',
      fileSizeBytes: 1024,
      completionTransition: null,
    });
    await queue.enqueueJobAttachmentPhoto({
      jobId: 'job-1',
      jobTitle: 'Fix sink',
      attachmentType: 'photo',
      title: 'Field 1',
      localFileUri: 'file:///b.jpg',
      mimeType: 'image/jpeg',
      fileSizeBytes: 2048,
      completionTransition: null,
    });
    await queue.enqueueJobAttachmentNote({
      jobId: 'job-1',
      jobTitle: 'Fix sink',
      title: 'Completion note',
      content: 'Replaced gasket',
      completionTransition: 'completed',
    });

    const summary = queue.getJobQueueSummary('job-1');
    expect(summary.photoCount).toBe(2);
    expect(summary.noteCount).toBe(1);
    expect(summary.total).toBe(3);
    expect(queue.isJobQueued('job-1')).toBe(true);
  });

  it('drains attachment items in order: presign → PUT → POST', async () => {
    const queue = await import('../../mobile/lib/offlineQueue');
    await queue.enqueueJobAttachmentPhoto({
      jobId: 'job-1',
      attachmentType: 'photo',
      title: 'Field 1',
      localFileUri: 'file:///a.jpg',
      mimeType: 'image/jpeg',
      fileSizeBytes: 1024,
    });

    const result = await queue.drainQueue();
    expect(result.processed).toBe(1);
    expect(result.remaining).toBe(0);
    expect(apiCalls.map((c) => c.name)).toEqual([
      'requestAttachmentUpload',
      'uploadAttachmentBinary',
      'addAttachment',
    ]);
    const addCall = apiCalls[2];
    expect(addCall.args[1]).toBe('job-1');
    const body = addCall.args[2] as Record<string, unknown>;
    expect(body.attachment_type).toBe('photo');
    expect(body.object_path).toBe('uploads/abc');
  });

  it('keeps the photo at the head of the queue on a transient upload failure', async () => {
    const queue = await import('../../mobile/lib/offlineQueue');
    const { OfflineError } = await import('../../mobile/lib/api');
    nextUploadBinaryImpl = async () => {
      throw new OfflineError('Network request failed');
    };
    await queue.enqueueJobAttachmentPhoto({
      jobId: 'job-1',
      attachmentType: 'photo',
      title: 'Field 1',
      localFileUri: 'file:///a.jpg',
      mimeType: 'image/jpeg',
      fileSizeBytes: null,
    });

    const result = await queue.drainQueue();
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(1);
    const summary = queue.getJobQueueSummary('job-1');
    expect(summary.photoCount).toBe(1);
    expect(summary.lastError).toMatch(/network/i);
  });

  it('drops the item and surfaces a conflict on a 4xx response', async () => {
    const queue = await import('../../mobile/lib/offlineQueue');
    const { ApiError } = await import('../../mobile/lib/api');
    nextAddAttachmentImpl = async () => {
      throw new ApiError(410, 'Job no longer accepts attachments', null);
    };
    await queue.enqueueJobAttachmentPhoto({
      jobId: 'job-1',
      jobTitle: 'Fix sink',
      attachmentType: 'photo',
      title: 'Field 1',
      localFileUri: 'file:///a.jpg',
      mimeType: 'image/jpeg',
      fileSizeBytes: null,
    });

    const result = await queue.drainQueue();
    expect(result.conflicts).toBe(1);
    expect(result.remaining).toBe(0);
    const conflicts = queue.getConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('job_attachment');
    expect(conflicts[0].status).toBe(410);
    expect(conflicts[0].targetTitle).toBe('Fix sink');
  });

  it('persists across reload through AsyncStorage', async () => {
    const queue = await import('../../mobile/lib/offlineQueue');
    await queue.enqueueJobAttachmentNote({
      jobId: 'job-1',
      title: 'Completion note',
      content: 'Done',
      completionTransition: 'completed',
    });
    expect(memoryStore.get('voiceai.tech.offlineQueue.v2')).toBeTruthy();

    queue.__resetOfflineQueueForTests();
    await queue.loadQueue();
    const summary = queue.getJobQueueSummary('job-1');
    expect(summary.noteCount).toBe(1);
    expect(summary.transition).toBeNull();
  });

  it('drops posted items but never persists raw API credentials', async () => {
    const queue = await import('../../mobile/lib/offlineQueue');
    await queue.enqueueJobAttachmentNote({
      jobId: 'job-1',
      title: 'Completion note',
      content: 'Done',
    });
    const raw = memoryStore.get('voiceai.tech.offlineQueue.v2') ?? '';
    expect(raw).not.toMatch(/k1/);
    expect(raw).not.toMatch(/baseUrl/);
  });

  // Mirrors what CompletionSheet does when a network blip happens partway
  // through uploading several photos: the first photo lands online, the
  // second one fails with a network error, and the rest of the work
  // (remaining photo + note + completion_transition) gets persisted to the
  // queue. Once connectivity is back, draining replays everything in order
  // and only the final item carries the completion_transition.
  it('completion-sheet fallback: queues remaining work after a mid-upload network drop', async () => {
    const apiMod = await import('../../mobile/lib/api');
    const queue = await import('../../mobile/lib/offlineQueue');

    const photos = [
      { uri: 'file:///p1.jpg', mimeType: 'image/jpeg', fileSize: 100, attachmentType: 'photo' as const },
      { uri: 'file:///p2.jpg', mimeType: 'image/jpeg', fileSize: 200, attachmentType: 'photo' as const },
      { uri: 'file:///p3.jpg', mimeType: 'image/jpeg', fileSize: 300, attachmentType: 'photo' as const },
    ];
    const note = 'Job done';
    const completionTransition = 'completed';

    let putCallCount = 0;
    nextUploadBinaryImpl = async () => {
      putCallCount += 1;
      if (putCallCount === 2) {
        // Mid-upload network blip on the second photo.
        throw new TypeError('Network request failed');
      }
    };

    let firstSuccessfulUpload = false;
    try {
      for (let i = 0; i < photos.length; i++) {
        const isLast = i === photos.length - 1;
        const transitionForCall = isLast && note.length === 0 ? completionTransition : null;
        await apiMod.api.requestAttachmentUpload({}, {
          mime_type: photos[i].mimeType,
          size_bytes: photos[i].fileSize,
        });
        await apiMod.api.uploadAttachmentBinary(
          { uploadURL: 'http://put', objectPath: `uploads/${i}` },
          { uri: photos[i].uri, mimeType: photos[i].mimeType, sizeBytes: photos[i].fileSize },
        );
        await apiMod.api.addAttachment({}, 'job-7', {
          attachment_type: photos[i].attachmentType,
          title: `Photo ${i + 1}`,
          object_path: `uploads/${i}`,
          mime_type: photos[i].mimeType,
          file_size_bytes: photos[i].fileSize,
          completion_transition: transitionForCall,
        });
        if (i === 0) firstSuccessfulUpload = true;
      }
      throw new Error('expected mid-upload failure');
    } catch (err) {
      // Simulate CompletionSheet's queueRemaining(...) for everything from
      // the failing photo onward, plus the note and transition.
      expect(firstSuccessfulUpload).toBe(true);
      expect((err as Error).message).toMatch(/Network request failed/);
      const failingIndex = 1;
      const remaining = photos.slice(failingIndex);
      const willHaveNote = note.length > 0;
      for (let i = 0; i < remaining.length; i++) {
        const isLast = i === remaining.length - 1;
        const transitionForItem = isLast && !willHaveNote ? completionTransition : null;
        await queue.enqueueJobAttachmentPhoto({
          jobId: 'job-7',
          jobTitle: 'Test job',
          attachmentType: remaining[i].attachmentType,
          title: `Photo ${failingIndex + i + 1}`,
          localFileUri: `/tmp/test-doc/offline-attachments/persisted-${i}.jpg`,
          mimeType: remaining[i].mimeType,
          fileSizeBytes: remaining[i].fileSize,
          completionTransition: transitionForItem,
        });
      }
      if (willHaveNote) {
        await queue.enqueueJobAttachmentNote({
          jobId: 'job-7',
          jobTitle: 'Test job',
          title: 'Completion note',
          content: note,
          completionTransition,
        });
      }
    }

    // Queue should now hold the remaining 2 photos + 1 note, with the
    // completion_transition attached only to the note (the last item).
    const summary = queue.getJobQueueSummary('job-7');
    expect(summary.photoCount).toBe(2);
    expect(summary.noteCount).toBe(1);
    expect(summary.pendingCompletionTransition).toBe('completed');

    // Wipe the api-call log from the failed upload attempts and replay.
    apiCalls.length = 0;
    putCallCount = 0;
    nextUploadBinaryImpl = async () => undefined;
    const result = await queue.drainQueue();
    expect(result.processed).toBe(3);
    expect(result.remaining).toBe(0);

    // Verify exactly one completion_transition was sent, on the note (last
    // addAttachment call), so the job doesn't get marked complete twice.
    const addAttachmentCalls = apiCalls.filter((c) => c.name === 'addAttachment');
    expect(addAttachmentCalls).toHaveLength(3);
    const completionTransitions = addAttachmentCalls
      .map((c) => (c.args[2] as { completion_transition: string | null }).completion_transition);
    expect(completionTransitions).toEqual([null, null, 'completed']);
    // And the final replayed call is the note, not a photo.
    const lastCallBody = addAttachmentCalls[2].args[2] as { attachment_type: string };
    expect(lastCallBody.attachment_type).toBe('note');
  });
});
