import Constants from 'expo-constants';

const STORAGE_BASE_URL_KEY = 'voiceai.tech.baseUrl';
const STORAGE_API_KEY = 'voiceai.tech.apiKey';
const STORAGE_RESOURCE_ID = 'voiceai.tech.resourceId';
const STORAGE_RESOURCE_NAME = 'voiceai.tech.resourceName';
const STORAGE_PUSH_TOKEN_KEY = 'voiceai.tech.pushToken';
const STORAGE_PUSH_ENABLED_KEY = 'voiceai.tech.pushEnabled';

export const STORAGE_KEYS = {
  baseUrl: STORAGE_BASE_URL_KEY,
  apiKey: STORAGE_API_KEY,
  resourceId: STORAGE_RESOURCE_ID,
  resourceName: STORAGE_RESOURCE_NAME,
  pushToken: STORAGE_PUSH_TOKEN_KEY,
  pushEnabled: STORAGE_PUSH_ENABLED_KEY,
};

export interface DispatchJob {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  status:
    | 'pending'
    | 'assigned'
    | 'scheduled'
    | 'en_route'
    | 'on_site'
    | 'in_progress'
    | 'completed'
    | 'incomplete'
    | 'cancelled'
    | 'done';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  scheduled_at: string | null;
  eta_start: string | null;
  eta_end: string | null;
  notes: string | null;
  job_type: string | null;
  assignee_user_id: string | null;
  resource_id: string | null;
  territory_id: string | null;
  estimated_duration_minutes: number | null;
  resource_name?: string | null;
  territory_name?: string | null;
  assignee_email?: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEvent {
  id: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  notes: string | null;
  created_at: string;
}

export interface DispatchResource {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  current_status: 'available' | 'busy' | 'unavailable' | null;
  status: 'active' | 'inactive';
  active_jobs: number;
  skills: string[] | null;
  territory_name?: string | null;
}

export interface SchedulingBooking {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  status:
    | 'pending'
    | 'confirmed'
    | 'checked_in'
    | 'completed'
    | 'cancelled'
    | 'no_show'
    | 'rescheduled';
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  notes: string | null;
  location: string | null;
  provider_id: string | null;
  appointment_type_id: string | null;
  resource_id: string | null;
  appointment_type_name?: string | null;
  appointment_type_color?: string | null;
  provider_name?: string | null;
  resource_name?: string | null;
}

export type BookingAction =
  | 'confirm'
  | 'check_in'
  | 'complete'
  | 'no_show'
  | 'cancel'
  | 'reopen';

export type DispatchTransition =
  | 'assigned'
  | 'scheduled'
  | 'en_route'
  | 'on_site'
  | 'in_progress'
  | 'completed'
  | 'incomplete'
  | 'cancelled'
  | 'done'
  | 'pending';

export interface ApiClient {
  baseUrl: string;
  apiKey: string;
}

interface ApiCallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  query?: Record<string, string | number | undefined | null>;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function buildUrl(
  base: string,
  path: string,
  query?: ApiCallOptions['query'],
): string {
  const trimmed = base.replace(/\/+$/, '');
  const url = new URL(`${trimmed}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function getDefaultApiUrl(): string {
  const fromExtra =
    (Constants.expoConfig?.extra as Record<string, unknown> | undefined)
      ?.defaultApiUrl;
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  return process.env.EXPO_PUBLIC_API_URL ?? 'https://api.example.com';
}

export async function apiCall<T>(
  client: ApiClient | null,
  path: string,
  opts: ApiCallOptions = {},
): Promise<T> {
  if (!client) {
    throw new ApiError(401, 'Not signed in', null);
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${client.apiKey}`,
  };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(buildUrl(client.baseUrl, path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body
        ? String((body as { error?: string }).error)
        : null) ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message, body);
  }

  return body as T;
}

export const api = {
  listJobs(
    client: ApiClient,
    params: {
      resourceId?: string | null;
      status?: string;
      limit?: number;
      page?: number;
    } = {},
  ): Promise<{ jobs: DispatchJob[]; total: number }> {
    return apiCall(client, '/api/v1/dispatch/jobs', {
      query: {
        resource_id: params.resourceId ?? undefined,
        status: params.status,
        limit: params.limit,
        page: params.page,
      },
    });
  },
  getJob(
    client: ApiClient,
    id: string,
  ): Promise<{ job: DispatchJob; events: JobEvent[] }> {
    return apiCall(client, `/api/v1/dispatch/jobs/${id}`);
  },
  transitionJob(
    client: ApiClient,
    id: string,
    status: DispatchTransition,
    notes?: string,
  ): Promise<{ job: DispatchJob }> {
    return apiCall(client, `/api/v1/dispatch/jobs/${id}/transition`, {
      method: 'POST',
      body: { status, notes },
    });
  },
  listResources(
    client: ApiClient,
  ): Promise<{ resources: DispatchResource[]; total: number }> {
    return apiCall(client, '/api/v1/dispatch/resources', {
      query: { limit: 100 },
    });
  },
  listBookings(
    client: ApiClient,
    params: {
      start?: string;
      end?: string;
      status?: string;
      resourceId?: string | null;
      providerId?: string | null;
    } = {},
  ): Promise<{ bookings: SchedulingBooking[]; total: number }> {
    return apiCall(client, '/api/v1/scheduling/bookings', {
      query: {
        start: params.start,
        end: params.end,
        status: params.status,
        resource_id: params.resourceId ?? undefined,
        provider_id: params.providerId ?? undefined,
      },
    });
  },
  getBooking(
    client: ApiClient,
    id: string,
  ): Promise<{ booking: SchedulingBooking }> {
    return apiCall(client, `/api/v1/scheduling/bookings/${id}`);
  },
  transitionBooking(
    client: ApiClient,
    id: string,
    action: BookingAction,
    extra: { cancellation_reason?: string } = {},
  ): Promise<{ booking: SchedulingBooking }> {
    return apiCall(client, `/api/v1/scheduling/bookings/${id}/transition`, {
      method: 'POST',
      body: { action, ...extra },
    });
  },
  registerDevice(
    client: ApiClient,
    body: {
      token: string;
      resource_id?: string | null;
      platform?: 'expo' | 'ios' | 'android' | 'web';
      device_label?: string;
      app_version?: string;
      push_enabled?: boolean;
    },
  ): Promise<{ device: RegisteredDevice }> {
    return apiCall(client, '/api/v1/mobile/devices', {
      method: 'POST',
      body,
    });
  },
  updateDevice(
    client: ApiClient,
    token: string,
    body: { push_enabled?: boolean; resource_id?: string | null },
  ): Promise<{ device: RegisteredDevice }> {
    return apiCall(
      client,
      `/api/v1/mobile/devices/${encodeURIComponent(token)}`,
      { method: 'PATCH', body },
    );
  },
  deleteDevice(
    client: ApiClient,
    token: string,
  ): Promise<{ success: boolean; removed: number }> {
    return apiCall(
      client,
      `/api/v1/mobile/devices/${encodeURIComponent(token)}`,
      { method: 'DELETE' },
    );
  },
};

export interface RegisteredDevice {
  id: string;
  tenant_id: string;
  resource_id: string | null;
  user_id: string | null;
  push_token: string;
  platform: string;
  push_enabled: boolean;
  device_label: string;
  app_version: string;
  last_seen_at: string;
}
