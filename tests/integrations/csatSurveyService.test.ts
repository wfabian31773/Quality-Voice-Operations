// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

type QueryResult = { rows: unknown[]; rowCount?: number };

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({ query: queryMock, release: releaseMock }));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  withPrivilegedClient: async (fn: (c: unknown) => unknown) => fn({ query: queryMock }),
}));

import {
  normalizeScore,
  buildCsatSmsBody,
  tryRecordSmsCsatResponse,
  getTenantCsatAggregate,
  dispatchSmsCsatSurvey,
  validateCsatSettingsUpdate,
  updateTenantCsatSettings,
} from '../../platform/analytics/CsatSurveyService';

beforeEach(() => {
  queryMock.mockReset();
  connectMock.mockClear();
  releaseMock.mockClear();
});

describe('normalizeScore', () => {
  it('maps 1..5 onto [0,1] with anchors at the ends', () => {
    expect(normalizeScore(1, 5)).toBeCloseTo(0, 5);
    expect(normalizeScore(3, 5)).toBeCloseTo(0.5, 5);
    expect(normalizeScore(5, 5)).toBeCloseTo(1, 5);
  });

  it('maps 0..10 / 1..10 inputs onto [0,1] with anchors at the ends', () => {
    // The implementation prefers the 1-based interpretation when both
    // are in range, so 1 -> 0 and 10 -> 1 on a "scale=10" survey, while
    // a true 0 falls back to the 0-based path (0/10 = 0).
    expect(normalizeScore(0, 10)).toBeCloseTo(0, 5);
    expect(normalizeScore(1, 10)).toBeCloseTo(0, 5);
    expect(normalizeScore(10, 10)).toBeCloseTo(1, 5);
    // Midpoint of 1..10 is 5.5 → 0.5
    expect(normalizeScore(5.5, 10)).toBeCloseTo(0.5, 3);
  });

  it('rejects out-of-range and degenerate inputs', () => {
    expect(normalizeScore(6, 5)).toBeNull();
    expect(normalizeScore(NaN, 5)).toBeNull();
    expect(normalizeScore(3, 1)).toBeNull();
    expect(normalizeScore(3, 99)).toBeNull();
  });
});

describe('buildCsatSmsBody', () => {
  it('appends the rating instructions and STOP footer', () => {
    const body = buildCsatSmsBody(null, 5);
    expect(body).toContain('1-5');
    expect(body.toUpperCase()).toContain('STOP');
  });

  it('honors a custom tenant template and reflects scale', () => {
    const body = buildCsatSmsBody('Custom CSAT prompt', 10);
    expect(body.startsWith('Custom CSAT prompt')).toBe(true);
    expect(body).toContain('1-10');
  });

  it('caps the prompt prefix to keep SMS within two segments', () => {
    const long = 'X'.repeat(500);
    const body = buildCsatSmsBody(long, 5);
    // Prefix is capped at 200 chars, but the trailing instructions add ~50.
    expect(body.length).toBeLessThan(300);
  });
});

describe('tryRecordSmsCsatResponse', () => {
  it('returns no_score_in_body when the message has no leading digit', async () => {
    const result = await tryRecordSmsCsatResponse('t', '+15551234567', 'thanks!');
    expect(result.handled).toBe(false);
    if (!result.handled) expect(result.reason).toBe('no_score_in_body');
    // Should never have hit the DB
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('returns score_out_of_range for impossible scores', async () => {
    const result = await tryRecordSmsCsatResponse('t', '+15551234567', '99 wow');
    expect(result.handled).toBe(false);
    if (!result.handled) expect(result.reason).toBe('score_out_of_range');
  });

  it('returns no_pending_survey if the customer has nothing outstanding', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) return { rows: [] };
      if (t.startsWith('SELECT')) return { rows: [] };
      return { rows: [] };
    });
    const result = await tryRecordSmsCsatResponse('t', '+15551234567', '5');
    expect(result.handled).toBe(false);
    if (!result.handled) expect(result.reason).toBe('no_pending_survey');
  });

  it('updates the pending row to responded with normalized score and trailing comment', async () => {
    const pending = {
      id: 'csat-1',
      tenant_id: 't',
      call_session_id: 'call-9',
      request_channel: 'sms',
      response_channel: null,
      status: 'pending',
      score_scale: 5,
      score_raw: null,
      score_normalized: null,
      comment: null,
      raw_response: null,
      dispatch_to: '+15551234567',
      dispatch_token: null,
      requested_at: new Date().toISOString(),
      responded_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      metadata: { scale: 5 },
    };

    let updateParams: unknown[] | undefined;
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) return { rows: [] };
      if (t.startsWith('SELECT')) return { rows: [pending] };
      if (t.startsWith('UPDATE')) {
        updateParams = params;
        const row = {
          ...pending,
          status: 'responded',
          response_channel: 'sms',
          score_scale: 5,
          score_raw: 4,
          score_normalized: 0.75,
          comment: 'great call',
          raw_response: '4 great call',
          responded_at: new Date().toISOString(),
        };
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [] };
    });

    const result = await tryRecordSmsCsatResponse('t', '+15551234567', '4 great call');
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.csat.scoreRaw).toBe(4);
      expect(result.csat.scoreNormalized).toBeCloseTo(0.75, 5);
      expect(result.csat.comment).toBe('great call');
      expect(result.csat.responseChannel).toBe('sms');
    }
    // raw_response (last param) should preserve the full inbound body
    expect(updateParams?.[6]).toBe('4 great call');
  });
});

describe('getTenantCsatAggregate', () => {
  it('rescales mean_normalized onto a 0..10 axis and rounds to 2dp', async () => {
    const stubClient = {
      query: vi.fn(async () => ({
        rows: [{ response_count: 7, mean_normalized: 0.834, top_box_rate: 0.42 }],
      })),
    };
    const agg = await getTenantCsatAggregate(stubClient as never, 't', new Date(0), new Date());
    expect(agg.responseCount).toBe(7);
    expect(agg.meanNormalized).toBeCloseTo(0.834, 5);
    expect(agg.meanOnTen).toBe(8.34);
    expect(agg.topBoxRate).toBeCloseTo(0.42, 5);
  });

  it('returns zeros when no responses landed in the window', async () => {
    const stubClient = {
      query: vi.fn(async () => ({
        rows: [{ response_count: 0, mean_normalized: 0, top_box_rate: 0 }],
      })),
    };
    const agg = await getTenantCsatAggregate(stubClient as never, 't', new Date(0), new Date());
    expect(agg.responseCount).toBe(0);
    expect(agg.meanOnTen).toBe(0);
  });
});

describe('dispatchSmsCsatSurvey', () => {
  it('creates a pending row, calls send, and stamps the Twilio SID into metadata', async () => {
    const created = {
      id: 'csat-1',
      tenant_id: 't',
      call_session_id: 'call-9',
      request_channel: 'sms',
      response_channel: null,
      status: 'pending',
      score_scale: 5,
      score_raw: null,
      score_normalized: null,
      comment: null,
      raw_response: null,
      dispatch_to: '+15551234567',
      dispatch_token: null,
      requested_at: new Date().toISOString(),
      responded_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      metadata: { scale: 5 },
    };

    let sawMetadataUpdate = false;
    queryMock.mockImplementation(async (sql: string) => {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) return { rows: [] };
      if (t.startsWith('INSERT INTO CALL_CSAT_RESPONSES')) return { rows: [created], rowCount: 1 };
      // createCsatRequest "already-exists" upsert path uses the same INSERT;
      // the metadata update is the only UPDATE we expect here.
      if (t.startsWith('UPDATE CALL_CSAT_RESPONSES')) {
        sawMetadataUpdate = true;
        return { rows: [], rowCount: 1 };
      }
      if (t.startsWith('SELECT')) return { rows: [] };
      return { rows: [] };
    });

    const send = vi.fn(async () => ({ sid: 'SM_TEST_SID' }));
    const result = await dispatchSmsCsatSurvey({
      tenantId: 't',
      callSessionId: 'call-9',
      callerNumber: '+15551234567',
      fromNumber: '+15557654321',
      scale: 5,
      template: null,
      send,
    });

    expect(result.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [to, from, body] = send.mock.calls[0];
    expect(to).toBe('+15551234567');
    expect(from).toBe('+15557654321');
    expect(body).toMatch(/Reply 1-5/);
    expect(sawMetadataUpdate).toBe(true);
  });

  it('persists score_scale on the pending row so non-default scales survive web/email submissions', async () => {
    let insertParams: unknown[] | undefined;
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) return { rows: [] };
      if (t.startsWith('INSERT INTO CALL_CSAT_RESPONSES')) {
        insertParams = params;
        return {
          rows: [{
            id: 'csat-2',
            tenant_id: 't',
            call_session_id: 'call-99',
            request_channel: 'sms',
            response_channel: null,
            status: 'pending',
            score_scale: params?.[4] ?? 5,
            score_raw: null,
            score_normalized: null,
            comment: null,
            raw_response: null,
            dispatch_to: '+15551234567',
            dispatch_token: null,
            requested_at: new Date().toISOString(),
            responded_at: null,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            metadata: { scale: 10 },
          }],
          rowCount: 1,
        };
      }
      if (t.startsWith('UPDATE CALL_CSAT_RESPONSES')) return { rows: [], rowCount: 1 };
      if (t.startsWith('SELECT')) return { rows: [] };
      return { rows: [] };
    });

    const send = vi.fn(async () => ({ sid: 'SM_TEST_SID_2' }));
    const result = await dispatchSmsCsatSurvey({
      tenantId: 't',
      callSessionId: 'call-99',
      callerNumber: '+15551234567',
      fromNumber: '+15557654321',
      scale: 10,
      template: null,
      send,
    });

    expect(result.sent).toBe(true);
    // Index 4 in the INSERT bind list is score_scale (after id/tenant/session/channel)
    expect(insertParams?.[4]).toBe(10);
    expect(result.csat?.scoreScale).toBe(10);
    // SMS body should reflect the 1-10 scale, not the default 1-5
    const [, , body] = send.mock.calls[0];
    expect(body).toMatch(/Reply 1-10/);
  });

  it('refuses to dispatch when caller or from number is missing', async () => {
    const send = vi.fn();
    const result = await dispatchSmsCsatSurvey({
      tenantId: 't',
      callSessionId: 'call-9',
      callerNumber: '',
      fromNumber: '+15557654321',
      scale: 5,
      template: null,
      send,
    });
    expect(result.sent).toBe(false);
    expect(result.error).toBe('missing_numbers');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('validateCsatSettingsUpdate', () => {
  it('accepts an empty payload', () => {
    expect(validateCsatSettingsUpdate({})).toBeNull();
  });

  it('accepts a fully-specified valid payload', () => {
    expect(validateCsatSettingsUpdate({
      enabled: true,
      channel: 'sms',
      scale: 5,
      minDurationSeconds: 60,
      smsTemplate: 'Rate us!',
    })).toBeNull();
  });

  it('rejects an out-of-range scale', () => {
    expect(validateCsatSettingsUpdate({ scale: 1 })).toMatch(/scale/i);
    expect(validateCsatSettingsUpdate({ scale: 11 })).toMatch(/scale/i);
    expect(validateCsatSettingsUpdate({ scale: 5.5 })).toMatch(/scale/i);
  });

  it('rejects a duration outside the allowed window', () => {
    expect(validateCsatSettingsUpdate({ minDurationSeconds: 4 })).toMatch(/Duration|seconds/i);
    expect(validateCsatSettingsUpdate({ minDurationSeconds: 601 })).toMatch(/Duration|seconds/i);
  });

  it('rejects an unknown channel value', () => {
    expect(validateCsatSettingsUpdate({ channel: 'pigeon' as never })).toMatch(/channel/i);
    // IVR is captured on response rows but is not a configurable dispatch channel.
    expect(validateCsatSettingsUpdate({ channel: 'ivr' as never })).toMatch(/channel/i);
  });

  it('rejects an SMS template longer than 320 chars', () => {
    expect(validateCsatSettingsUpdate({ smsTemplate: 'x'.repeat(321) })).toMatch(/320/);
  });

  it('rejects a non-boolean enabled flag', () => {
    expect(validateCsatSettingsUpdate({ enabled: 'true' as never })).toMatch(/boolean/i);
  });
});

describe('updateTenantCsatSettings', () => {
  it('builds a SET clause containing only the supplied fields', async () => {
    let updateSql: string | undefined;
    let updateParams: unknown[] | undefined;
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) return { rows: [] };
      if (t.startsWith('UPDATE TENANTS')) {
        updateSql = sql;
        updateParams = params;
        return { rows: [], rowCount: 1 };
      }
      // Final SELECT to re-read settings
      if (t.startsWith('SELECT')) {
        return {
          rows: [{
            csat_survey_enabled: true,
            csat_survey_channel: 'sms',
            csat_survey_scale: 7,
            csat_survey_min_duration_seconds: 45,
            csat_survey_sms_template: null,
          }],
        };
      }
      return { rows: [] };
    });

    const result = await updateTenantCsatSettings('tenant-A', {
      enabled: true,
      scale: 7,
      minDurationSeconds: 45,
    });

    expect(updateSql).toMatch(/csat_survey_enabled = \$2/);
    expect(updateSql).toMatch(/csat_survey_scale = \$3/);
    expect(updateSql).toMatch(/csat_survey_min_duration_seconds = \$4/);
    // Channel/template not in the SET clause because they weren't supplied.
    expect(updateSql).not.toMatch(/csat_survey_channel =/);
    expect(updateSql).not.toMatch(/csat_survey_sms_template =/);
    expect(updateParams?.[0]).toBe('tenant-A');
    expect(updateParams?.[1]).toBe(true);
    expect(updateParams?.[2]).toBe(7);
    expect(updateParams?.[3]).toBe(45);
    expect(result.scale).toBe(7);
    expect(result.minDurationSeconds).toBe(45);
  });

  it('coerces an empty SMS template to null so the service-default copy is used', async () => {
    let updateParams: unknown[] | undefined;
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('BEGIN') || t.startsWith('COMMIT') || t.startsWith('ROLLBACK')) return { rows: [] };
      if (t.startsWith('UPDATE TENANTS')) {
        updateParams = params;
        return { rows: [], rowCount: 1 };
      }
      if (t.startsWith('SELECT')) {
        return {
          rows: [{
            csat_survey_enabled: false,
            csat_survey_channel: 'sms',
            csat_survey_scale: 5,
            csat_survey_min_duration_seconds: 30,
            csat_survey_sms_template: null,
          }],
        };
      }
      return { rows: [] };
    });

    await updateTenantCsatSettings('tenant-A', { smsTemplate: '   ' });
    // tenantId at $1, then the template — empty string should become null.
    expect(updateParams?.[1]).toBeNull();
  });

  it('skips the UPDATE entirely on an empty payload but still returns settings', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const t = sql.trim().toUpperCase();
      if (t.startsWith('SELECT')) {
        return {
          rows: [{
            csat_survey_enabled: false,
            csat_survey_channel: 'sms',
            csat_survey_scale: 5,
            csat_survey_min_duration_seconds: 30,
            csat_survey_sms_template: null,
          }],
        };
      }
      throw new Error(`Unexpected SQL on empty payload: ${t}`);
    });

    const result = await updateTenantCsatSettings('tenant-A', {});
    expect(result.enabled).toBe(false);
    // Only the SELECT (re-read) ran — no BEGIN/UPDATE.
    expect(queryMock.mock.calls.every((c) => !String(c[0]).toUpperCase().startsWith('UPDATE'))).toBe(true);
  });
});
