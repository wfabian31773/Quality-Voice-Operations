import { createLogger } from '../../core/logger';

const logger = createLogger('AZUL_SCHEDULE');

export interface ScheduleLookupParams {
  phone?: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
}

interface ScheduleRow {
  PatientFirstName: string;
  PatientLastName: string;
  PatientCellPhone: string | null;
  PatientHomePhone: string | null;
  PatientDOB: string | null;
  AppointmentDate: string | null;
  AppointmentTime: string | null;
  AppointmentType: string | null;
  ProviderName: string | null;
  Location: string | null;
  Status: string | null;
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

function getSupabaseUrl(): string | null {
  return process.env.SUPABASE_DATABASE_URL || null;
}

let poolInstance: import('pg').Pool | null = null;

async function getPool(): Promise<import('pg').Pool | null> {
  const url = getSupabaseUrl();
  if (!url) return null;

  if (!poolInstance) {
    const { Pool } = await import('pg');
    poolInstance = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return poolInstance;
}

export async function lookupPatientSchedule(
  params: ScheduleLookupParams,
): Promise<string | null> {
  const pool = await getPool();
  if (!pool) {
    logger.warn('Schedule lookup not configured — SUPABASE_DATABASE_URL missing');
    return null;
  }

  try {
    let rows: ScheduleRow[] = [];

    if (params.firstName && params.lastName && params.dob) {
      const result = await pool.query<ScheduleRow>(
        `SELECT "PatientFirstName", "PatientLastName", "PatientCellPhone", "PatientHomePhone",
                "PatientDOB", "AppointmentDate", "AppointmentTime", "AppointmentType",
                "ProviderName", "Location", "Status"
         FROM "Schedule"
         WHERE LOWER("PatientFirstName") = LOWER($1)
           AND LOWER("PatientLastName") = LOWER($2)
           AND "PatientDOB" = $3
         ORDER BY "AppointmentDate" DESC
         LIMIT 10`,
        [params.firstName.trim(), params.lastName.trim(), params.dob.trim()],
      );
      rows = result.rows;
    }

    if (rows.length === 0 && params.phone) {
      const normalized = normalizePhone(params.phone);
      if (normalized.length === 10) {
        const result = await pool.query<ScheduleRow>(
          `SELECT "PatientFirstName", "PatientLastName", "PatientCellPhone", "PatientHomePhone",
                  "PatientDOB", "AppointmentDate", "AppointmentTime", "AppointmentType",
                  "ProviderName", "Location", "Status"
           FROM "Schedule"
           WHERE REPLACE(REPLACE(REPLACE(REPLACE("PatientCellPhone", '-', ''), '(', ''), ')', ''), ' ', '') LIKE '%' || $1
              OR REPLACE(REPLACE(REPLACE(REPLACE("PatientHomePhone", '-', ''), '(', ''), ')', ''), ' ', '') LIKE '%' || $1
           ORDER BY "AppointmentDate" DESC
           LIMIT 10`,
          [normalized],
        );
        rows = result.rows;
      }
    }

    if (rows.length === 0 && params.firstName && params.lastName) {
      const result = await pool.query<ScheduleRow>(
        `SELECT "PatientFirstName", "PatientLastName", "PatientCellPhone", "PatientHomePhone",
                "PatientDOB", "AppointmentDate", "AppointmentTime", "AppointmentType",
                "ProviderName", "Location", "Status"
         FROM "Schedule"
         WHERE LOWER("PatientFirstName") = LOWER($1)
           AND LOWER("PatientLastName") = LOWER($2)
         ORDER BY "AppointmentDate" DESC
         LIMIT 10`,
        [params.firstName.trim(), params.lastName.trim()],
      );
      rows = result.rows;
    }

    if (rows.length === 0) {
      return null;
    }

    return formatSchedule(rows);
  } catch (err) {
    logger.error('Schedule lookup failed', { error: String(err) });
    return null;
  }
}

function formatSchedule(rows: ScheduleRow[]): string {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  const upcoming: string[] = [];
  const past: string[] = [];

  for (const row of rows) {
    const dateStr = row.AppointmentDate
      ? new Date(row.AppointmentDate).toISOString().split('T')[0]
      : null;
    const line = [
      dateStr ?? 'Unknown date',
      row.AppointmentTime ?? '',
      row.AppointmentType ?? '',
      row.ProviderName ? `with ${row.ProviderName}` : '',
      row.Location ? `at ${row.Location}` : '',
      row.Status ? `(${row.Status})` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    if (dateStr && dateStr >= todayStr) {
      upcoming.push(line);
    } else {
      past.push(line);
    }
  }

  const parts: string[] = [];
  parts.push(`Patient: ${rows[0].PatientFirstName} ${rows[0].PatientLastName}`);

  if (upcoming.length > 0) {
    parts.push(`Upcoming appointments:\n${upcoming.join('\n')}`);
  } else {
    parts.push('No upcoming appointments found.');
  }

  if (past.length > 0) {
    parts.push(`Recent past appointments:\n${past.slice(0, 5).join('\n')}`);
  }

  return parts.join('\n\n');
}

export async function closeSchedulePool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}
