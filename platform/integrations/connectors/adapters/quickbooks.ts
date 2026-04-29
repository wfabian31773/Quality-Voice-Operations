import { createLogger } from '../../../core/logger';
import { ensureFreshOAuthToken } from '../tokenRefresh';
import { retryFetch } from '../retryWithBackoff';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('QUICKBOOKS_CONNECTOR');
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * BL-014 (Task #505): every QuickBooks HTTP call goes through `qboFetch`,
 * which routes through `retryFetch` so a transient 429 (Intuit honours
 * `Retry-After` on rate-limit responses) or 5xx is retried with the shared
 * 1s/4s/16s ±20% jitter schedule before surfacing the failure. Each retry
 * attempt gets a fresh `AbortController` armed at the `REQUEST_TIMEOUT_MS`
 * per-attempt budget; the helper enforces the 60s total dispatch budget.
 */
async function qboHttpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { signal: _ignored, ...rest } = init;
  void _ignored;
  return retryFetch(url, rest, {
    label: 'quickbooks',
    fetcher: async (input, opts) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetch(input, { ...opts, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

interface QboAuth {
  accessToken: string;
  realmId: string;
  apiBase: string;
  minorVersion: string;
}

function resolveAuth(config: ConnectorConfig): QboAuth | null {
  const accessToken = config.credentials.access_token ?? '';
  const realmId = config.credentials.realm_id ?? config.credentials.company_id ?? '';
  if (!accessToken || !realmId) return null;
  const env = (config.credentials.environment ?? 'production').toLowerCase();
  const apiBase = env === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  return { accessToken, realmId, apiBase, minorVersion: '70' };
}

async function qboFetch<T = unknown>(
  auth: QboAuth,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${auth.apiBase}/v3/company/${auth.realmId}${path}${sep}minorversion=${auth.minorVersion}`;
    const res = await qboHttpFetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `QuickBooks ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

interface QboCustomerQuery {
  QueryResponse: { Customer?: Array<{ Id: string; DisplayName: string }> };
}

interface QboCustomerCreate {
  Customer: { Id: string; DisplayName: string };
}

interface QboInvoiceCreate {
  Invoice: { Id: string; DocNumber?: string };
}

export class QuickBooksConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    let activeConfig = config;
    try {
      activeConfig = await ensureFreshOAuthToken(config);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('QuickBooks token refresh failed', { tenantId, error });
      return { success: false, error: `QuickBooks token refresh failed: ${error}` };
    }
    const auth = resolveAuth(activeConfig);
    if (!auth) {
      logger.error('Missing QuickBooks credentials', { tenantId });
      return { success: false, error: 'QuickBooks connector not configured: missing access_token or realm_id' };
    }

    switch (payload.type) {
      case 'call.completed':
        return this.handleCallCompleted(tenantId, activeConfig, auth, payload);
      case 'appointment.booked':
        return this.handleAppointmentBooked(tenantId, auth, payload);
      default:
        return { success: false, error: `QuickBooks adapter does not handle event: ${payload.type}` };
    }
  }

  private async handleCallCompleted(
    tenantId: TenantId,
    config: ConnectorConfig,
    auth: QboAuth,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;

    try {
      const customerId = await this.findOrCreateCustomer(auth, payload, callerPhone);

      const invoiceItemId = config.credentials.invoice_item_id ?? '';
      const invoiceAmountRaw = (payload.invoiceAmount as number | string | undefined)
        ?? config.credentials.default_invoice_amount;
      const invoiceAmount = invoiceAmountRaw !== undefined && invoiceAmountRaw !== ''
        ? Number(invoiceAmountRaw)
        : NaN;
      const shouldInvoice = customerId
        && invoiceItemId
        && Number.isFinite(invoiceAmount)
        && invoiceAmount > 0;

      let invoiceId: string | undefined;
      let invoiceNumber: string | undefined;
      if (shouldInvoice) {
        const invoice = await this.createInvoice(auth, {
          customerId: customerId!,
          itemId: invoiceItemId,
          amount: invoiceAmount,
          description: (payload.summary as string | undefined) ?? 'AI voice call service',
        });
        invoiceId = invoice?.id;
        invoiceNumber = invoice?.docNumber;
      }

      logger.info('QuickBooks call.completed processed', {
        tenantId,
        customerId,
        invoiceId,
        invoiced: !!invoiceId,
      });

      return {
        success: true,
        externalId: invoiceId ?? customerId,
        meta: {
          customerId,
          invoiceId,
          invoiceNumber,
          invoiced: !!invoiceId,
          provider: 'quickbooks',
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('QuickBooks call.completed failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async handleAppointmentBooked(
    tenantId: TenantId,
    auth: QboAuth,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const callerPhone = payload.callerPhone as string | undefined;

    try {
      const customerId = await this.findOrCreateCustomer(auth, payload, callerPhone);
      logger.info('QuickBooks customer ensured for appointment', { tenantId, customerId });
      return {
        success: true,
        externalId: customerId,
        meta: { customerId, provider: 'quickbooks' },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('QuickBooks appointment sync failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private async findOrCreateCustomer(
    auth: QboAuth,
    payload: ConnectorPayload,
    phone: string | undefined,
  ): Promise<string | undefined> {
    const firstName = (payload.callerFirstName as string) ?? '';
    const lastName = (payload.callerLastName as string) ?? '';
    const email = (payload.callerEmail as string) ?? '';
    const displayName = [firstName, lastName].filter(Boolean).join(' ').trim()
      || (phone ? `Caller ${phone}` : 'AI Voice Caller');

    const escaped = displayName.replace(/'/g, "''");
    const query = `SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 1`;
    const search = await qboFetch<QboCustomerQuery>(auth, `/query?query=${encodeURIComponent(query)}`);
    if (search.ok && search.data?.QueryResponse?.Customer?.length) {
      return search.data.QueryResponse.Customer[0].Id;
    }

    const customerBody: Record<string, unknown> = {
      DisplayName: displayName,
      ...(firstName ? { GivenName: firstName } : {}),
      ...(lastName ? { FamilyName: lastName } : {}),
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
      ...(phone ? { PrimaryPhone: { FreeFormNumber: phone } } : {}),
    };
    const create = await qboFetch<QboCustomerCreate>(auth, '/customer', {
      method: 'POST',
      body: customerBody,
    });
    if (!create.ok || !create.data?.Customer?.Id) {
      logger.warn('QuickBooks customer create failed', { error: create.error });
      return undefined;
    }
    return create.data.Customer.Id;
  }

  private async createInvoice(
    auth: QboAuth,
    params: { customerId: string; itemId: string; amount: number; description: string },
  ): Promise<{ id: string; docNumber?: string } | undefined> {
    const body = {
      CustomerRef: { value: params.customerId },
      Line: [
        {
          DetailType: 'SalesItemLineDetail',
          Amount: params.amount,
          Description: params.description.slice(0, 4000),
          SalesItemLineDetail: {
            ItemRef: { value: params.itemId },
            Qty: 1,
            UnitPrice: params.amount,
          },
        },
      ],
    };
    const res = await qboFetch<QboInvoiceCreate>(auth, '/invoice', { method: 'POST', body });
    if (!res.ok || !res.data?.Invoice?.Id) {
      logger.warn('QuickBooks invoice create failed', { error: res.error });
      return undefined;
    }
    return { id: res.data.Invoice.Id, docNumber: res.data.Invoice.DocNumber };
  }
}
