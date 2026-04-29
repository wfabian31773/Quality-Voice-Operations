// Integration-level test that drives the mobile offline queue end-to-end
// against a real instance of the dispatch API the way a technician's
// device does in the field. Unlike `tests/mobile/offlineQueueAttachments.test.ts`
// (which mocks `mobile/lib/api`), this test:
//
//   1. Boots the actual `mobileApiRoutes` express router (with the
//      Postgres pool and ObjectStorage layer mocked just enough to
//      respond) on an ephemeral 127.0.0.1 port.
//   2. Lets `mobile/lib/offlineQueue` and `mobile/lib/api` execute as
//      shipped — real `fetch`, real request shaping — so we exercise the
//      full presigned URL → PUT → POST attachment flow.
//   3. Asserts that the dispatch API ends up with both attachments AND
//      the `completion_transition` fired (job lands in `completed`,
//      status_change event is recorded, fireNotifications() runs).
//
// This catches regressions in request payloads (e.g. `object_path`
// casing, completion_transition coupling) when the API contract
// evolves — exactly the gap the unit tests can't cover because they
// call mocked stubs instead of the real handlers.
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Mobile-side native module stubs. These let `mobile/lib/offlineQueue.ts`
// and `mobile/lib/api.ts` import cleanly under Node — we still let the
// queue and API client themselves run for real.
// ---------------------------------------------------------------------------
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

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: {} } },
}));

vi.mock('expo-file-system', () => ({
  documentDirectory: '/tmp/test-doc/',
  getInfoAsync: async () => ({ exists: true }),
  makeDirectoryAsync: async () => undefined,
  readDirectoryAsync: async () => [],
  copyAsync: async () => undefined,
  deleteAsync: async () => undefined,
}));

const credsRef = {
  current: null as { baseUrl: string; apiKey: string } | null,
};
vi.mock('../../mobile/lib/auth', () => ({
  loadStoredCredentials: async () => credsRef.current,
}));

// ---------------------------------------------------------------------------
// Server-side mocks. The dispatch router uses a real Postgres pool and a
// real ObjectStorage client in production; here we stub both with just
// enough behaviour to act like the contract and capture what the mobile
// queue sent.
// ---------------------------------------------------------------------------
const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withPrivilegedClient: vi.fn(),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/notifications/dispatchPush', () => ({
  fireDispatchPush: vi.fn(),
}));

vi.mock('../../platform/email', () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  dispatchRouteExportReadyEmail: vi.fn(),
  dispatchRouteExportFailedEmail: vi.fn(),
  dispatchCompletionPhotosEmail: vi.fn(() => ({
    subject: 'photos',
    html: '<p>photos</p>',
    text: 'photos',
  })),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'tech-user',
      tenantId: 'tenant-A',
      role: 'tenant_owner',
      email: 'tech@example.com',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
  requireRole: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
  requirePlatformAdmin: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../server/admin-api/middleware/apiKeyAuth', () => ({
  requireApiKeyOrJwt: (
    jwt: (req: Request, res: Response, next: NextFunction) => void,
  ) => jwt,
}));

vi.mock('../../server/admin-api/middleware/apiKeyScope', () => ({
  requireApiKeyPermission: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../platform/integrations/routing', async () => {
  const actual = await vi.importActual<
    typeof import('../../platform/integrations/routing')
  >('../../platform/integrations/routing');
  return {
    ...actual,
    geocodeAddressCached: vi.fn(),
  };
});

// ObjectStorage stub that points back at the test PUT route bound to
// the local express server (port set in beforeAll, after we know it).
const uploadedObjects = new Map<string, Buffer>();
vi.mock('../../server/replit_integrations/object_storage', () => {
  let counter = 0;
  return {
    ObjectStorageService: class {
      async getObjectEntityUploadURL(): Promise<string> {
        counter += 1;
        const id = `obj_${counter}`;
        const base = (globalThis as { __OBJ_STORAGE_BASE?: string })
          .__OBJ_STORAGE_BASE;
        if (!base) throw new Error('Test object storage base URL not set');
        return `${base}/_test/uploads/${id}`;
      }
      normalizeObjectEntityPath(url: string): string {
        const parsed = new URL(url);
        return `/objects${parsed.pathname.replace('/_test/uploads', '/uploads')}`;
      }
      async trySetObjectEntityAclPolicy(path: string): Promise<string> {
        return path;
      }
    },
    ObjectNotFoundError: class extends Error {},
  };
});

// ---------------------------------------------------------------------------
// Test fixtures shared across the suite.
// ---------------------------------------------------------------------------
let httpServer: http.Server;
let baseUrl = '';
let jobState: { id: string; status: string };
let attachmentInserts: Array<{ params: unknown[]; attachment: { id: string } }>;
let eventInserts: Array<{ sql: string; params: unknown[] }>;
let jobUpdates: Array<{ params: unknown[] }>;
let notificationTemplateLookups: Array<{ params: unknown[] }>;
// Per-test override that lets a single test simulate a transient
// upload failure (e.g. flaky cell connection) on the first PUT and
// then recover on the retry. Reset to null in beforeEach.
let putFailureMode:
  | null
  | { failNext: number; status: number; failedIds: string[] } = null;

function configureQueryMock(): void {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, paramsRaw?: unknown) => {
    const text = typeof sql === 'string' ? sql : String(sql);
    const params = (Array.isArray(paramsRaw) ? paramsRaw : []) as unknown[];

    // The job-existence SELECT used by both addAttachmentHandler and
    // transitionJobHandler — strict shape match so we don't catch the
    // sendCompletionPhotosEmail SELECT (which is a different LEFT JOIN).
    if (
      /SELECT id, status FROM dispatch_jobs WHERE id = \$1 AND tenant_id = \$2/
        .test(text)
    ) {
      return { rows: [{ id: jobState.id, status: jobState.status }] };
    }

    if (/INSERT INTO dispatch_job_attachments/.test(text)) {
      const id = `att-${attachmentInserts.length + 1}`;
      const row = {
        id,
        job_id: params[0],
        tenant_id: params[1],
        attachment_type: params[2],
        title: params[3],
        content: params[4],
        file_url: params[5],
        object_path: params[6],
        mime_type: params[7],
        file_size_bytes: params[8],
        uploaded_by: params[9],
      };
      attachmentInserts.push({ params, attachment: row });
      return { rows: [row] };
    }

    if (/INSERT INTO dispatch_job_events/.test(text)) {
      eventInserts.push({ sql: text, params });
      return { rows: [] };
    }

    if (/UPDATE dispatch_jobs/.test(text)) {
      jobUpdates.push({ params });
      const newStatus = params[2] as string;
      jobState = { id: jobState.id, status: newStatus };
      return { rows: [{ id: jobState.id, status: newStatus }] };
    }

    if (/dispatch_notification_templates/.test(text)) {
      // Track that the notification dispatcher actually consulted its
      // template table — this is the load-bearing side effect that
      // proves `fireNotifications()` was invoked from the handler.
      notificationTemplateLookups.push({ params });
      return { rows: [] };
    }

    // Bad-arrival closest-approach lookup — return NULL so the helper
    // skips silently (no exception insert).
    if (/6371000 \* 2 \* ASIN/.test(text)) {
      return { rows: [{ closest_approach_m: null }] };
    }

    // sendCompletionPhotosEmail SELECTs from dispatch_jobs LEFT JOIN
    // tenants/resources, and from dispatch_job_attachments for photos.
    // Returning empty rows makes it bail before sending an email — we
    // already cover the "completed → completion_transition" assertion
    // through jobUpdates / eventInserts.
    return { rows: [] };
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Mock S3-style PUT target for the presigned upload URL. We capture
  // the raw bytes so the test can assert that the photo body actually
  // made it across the wire.
  app.put(
    '/_test/uploads/:id',
    express.raw({ type: '*/*', limit: '25mb' }),
    (req, res) => {
      // Optional fault injection: simulate the cell-network glitches
      // that drove the offline queue's existence in the first place.
      if (
        putFailureMode &&
        putFailureMode.failNext > 0 &&
        !putFailureMode.failedIds.includes(req.params.id)
      ) {
        putFailureMode.failNext -= 1;
        putFailureMode.failedIds.push(req.params.id);
        res.status(putFailureMode.status).end();
        return;
      }
      uploadedObjects.set(req.params.id, req.body as Buffer);
      res.status(200).end();
    },
  );

  const { default: mobileApiRouter } = await import(
    '../../server/admin-api/routes/mobileApi'
  );
  app.use(mobileApiRouter);

  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(0, '127.0.0.1', () => resolve());
    httpServer.once('error', reject);
  });

  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Test server failed to bind to a port');
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
  (globalThis as { __OBJ_STORAGE_BASE?: string }).__OBJ_STORAGE_BASE = baseUrl;
  credsRef.current = { baseUrl, apiKey: 'test-key' };
});

afterAll(async () => {
  if (httpServer) {
    await new Promise<void>((resolve) =>
      httpServer.close(() => resolve()),
    );
  }
});

beforeEach(async () => {
  memoryStore.clear();
  uploadedObjects.clear();
  jobState = { id: 'job-1', status: 'in_progress' };
  attachmentInserts = [];
  eventInserts = [];
  jobUpdates = [];
  notificationTemplateLookups = [];
  putFailureMode = null;
  configureQueryMock();
  const queue = await import('../../mobile/lib/offlineQueue');
  queue.__resetOfflineQueueForTests();
});

describe('offline queue → real dispatch API end-to-end', () => {
  it(
    'enqueued photo + note replay through presigned URL, PUT, and POST attachment, then fire the completion transition',
    async () => {
      const queue = await import('../../mobile/lib/offlineQueue');

      // The photo is shipped as a tiny 3-byte JPEG via a `data:` URL so
      // mobile/lib/api.ts's `fetch(file.uri).blob()` actually has bytes
      // to forward to the presigned PUT target.
      await queue.enqueueJobAttachmentPhoto({
        jobId: 'job-1',
        jobTitle: 'Fix sink',
        attachmentType: 'proof_of_completion',
        title: 'Proof photo',
        localFileUri: 'data:image/jpeg;base64,AAEC',
        mimeType: 'image/jpeg',
        fileSizeBytes: 3,
        completionTransition: null,
      });
      await queue.enqueueJobAttachmentNote({
        jobId: 'job-1',
        jobTitle: 'Fix sink',
        title: 'Completion note',
        content: 'Replaced gasket',
        completionTransition: 'completed',
      });

      const result = await queue.drainQueue();
      expect(result).toEqual({ processed: 2, conflicts: 0, remaining: 0 });

      // ── Both attachments landed in the dispatch_job_attachments table ──
      expect(attachmentInserts).toHaveLength(2);

      // First insert: the photo. The presigned-upload contract requires
      // the server to receive a non-null `object_path` (and now also a
      // resolved `file_url`, normalized through the storage ACL helper).
      const photoParams = attachmentInserts[0].params;
      expect(photoParams[0]).toBe('job-1');
      expect(photoParams[1]).toBe('tenant-A');
      expect(photoParams[2]).toBe('proof_of_completion');
      expect(photoParams[3]).toBe('Proof photo');
      expect(photoParams[5]).toMatch(/^\/objects\/uploads\/obj_/); // file_url
      expect(photoParams[6]).toMatch(/^\/objects\/uploads\/obj_/); // object_path
      expect(photoParams[7]).toBe('image/jpeg');
      expect(photoParams[8]).toBe(3);
      expect(photoParams[9]).toBe('tech-user');

      // Second insert: the note. No object_path / mime_type / size — it's
      // a plain text attachment, and the API must accept it without a
      // file payload.
      const noteParams = attachmentInserts[1].params;
      expect(noteParams[0]).toBe('job-1');
      expect(noteParams[1]).toBe('tenant-A');
      expect(noteParams[2]).toBe('note');
      expect(noteParams[3]).toBe('Completion note');
      expect(noteParams[4]).toBe('Replaced gasket');
      expect(noteParams[5]).toBeNull(); // file_url
      expect(noteParams[6]).toBeNull(); // object_path
      expect(noteParams[7]).toBeNull(); // mime_type
      expect(noteParams[8]).toBeNull(); // file_size_bytes

      // ── The presigned PUT actually forwarded the photo bytes ──
      expect(uploadedObjects.size).toBe(1);
      const [bytes] = [...uploadedObjects.values()];
      expect(Buffer.from(bytes)).toEqual(Buffer.from([0x00, 0x01, 0x02]));

      // ── The completion_transition fired on the second (note) call ──
      // Only one UPDATE should have run (the photo's completionTransition
      // was null, so the queue must NOT double-fire the transition).
      expect(jobUpdates).toHaveLength(1);
      const updateParams = jobUpdates[0].params;
      expect(updateParams[0]).toBe('job-1');
      expect(updateParams[1]).toBe('tenant-A');
      expect(updateParams[2]).toBe('completed');
      expect(jobState.status).toBe('completed');

      // ── A `status_change` event was recorded for the completion ──
      const statusChanges = eventInserts.filter((e) =>
        /status_change/.test(e.sql),
      );
      expect(statusChanges).toHaveLength(1);
      expect(statusChanges[0].params).toEqual(
        expect.arrayContaining([
          'job-1',
          'tenant-A',
          'in_progress',
          'completed',
          'tech-user',
        ]),
      );

      // ── The activity timeline got an `attachment_added` event for ──
      // ── each upload too. ──
      const attachmentEvents = eventInserts.filter((e) => {
        const meta = (e.params[4] ?? '') as string;
        return /attachment/i.test(meta);
      });
      expect(attachmentEvents.length).toBeGreaterThanOrEqual(2);

      // ── fireNotifications() actually ran on the server. ──
      // The completion_transition path calls fireNotifications, which
      // queries dispatch_notification_templates for matching triggers.
      // Seeing that lookup hit our query mock proves the notification
      // pipeline executed and didn't silently regress.
      expect(notificationTemplateLookups.length).toBeGreaterThanOrEqual(1);
      for (const lookup of notificationTemplateLookups) {
        expect(lookup.params[0]).toBe('tenant-A');
      }
    },
    20_000,
  );

  it(
    'leaves the photo at the head of the queue when the presigned PUT fails transiently, then drains cleanly once connectivity returns',
    async () => {
      const queue = await import('../../mobile/lib/offlineQueue');

      // Simulate the most common offline scenario: the upload PUT
      // returns a 5xx on the first attempt (e.g. the cell modem
      // dropped the packet). The queue must keep the item, surface
      // a transient error, and replay successfully on the next drain.
      putFailureMode = { failNext: 1, status: 503, failedIds: [] };

      await queue.enqueueJobAttachmentPhoto({
        jobId: 'job-1',
        jobTitle: 'Fix sink',
        attachmentType: 'proof_of_completion',
        title: 'Proof photo',
        localFileUri: 'data:image/jpeg;base64,AAEC',
        mimeType: 'image/jpeg',
        fileSizeBytes: 3,
        completionTransition: 'completed',
      });

      // First drain: PUT fails → executeAttachmentItem throws an
      // ApiError(503) → executeItem treats it as transient → the
      // queue retains the entry and reports 0 processed, 0 conflicts,
      // 1 remaining.
      const firstDrain = await queue.drainQueue();
      expect(firstDrain).toEqual({
        processed: 0,
        conflicts: 0,
        remaining: 1,
      });
      expect(attachmentInserts).toHaveLength(0);
      expect(jobUpdates).toHaveLength(0);
      expect(uploadedObjects.size).toBe(0);

      // Second drain (after "connectivity returns"): PUT succeeds and
      // the queue replays from the head, completing the entire flow.
      const secondDrain = await queue.drainQueue();
      expect(secondDrain).toEqual({
        processed: 1,
        conflicts: 0,
        remaining: 0,
      });
      expect(attachmentInserts).toHaveLength(1);
      expect(uploadedObjects.size).toBe(1);
      const [bytes] = [...uploadedObjects.values()];
      expect(Buffer.from(bytes)).toEqual(Buffer.from([0x00, 0x01, 0x02]));

      // The completion_transition rode along on the replay — the job
      // still ends up `completed` exactly once.
      expect(jobUpdates).toHaveLength(1);
      expect(jobUpdates[0].params[2]).toBe('completed');
      expect(jobState.status).toBe('completed');

      const statusChanges = eventInserts.filter((e) =>
        /status_change/.test(e.sql),
      );
      expect(statusChanges).toHaveLength(1);

      // And the notification pipeline still fired on the successful
      // retry — the transient PUT failure did not cause us to skip
      // notifying the dispatcher / customer.
      expect(notificationTemplateLookups.length).toBeGreaterThanOrEqual(1);
    },
    20_000,
  );
});
