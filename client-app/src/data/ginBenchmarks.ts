export type GinBenchmarkStatus = 'illustrative' | 'preview' | 'live';

export interface GinBenchmarkRow {
  vertical: string;
  metric: string;
  cohortAvg: string;
  median: string;
  topQuartile: string;
  cohortSize: number;
}

export interface GinBenchmarkSnapshot {
  status: GinBenchmarkStatus;
  snapshotAt: string | null;
  refreshCadence: string;
  kAnonymity: number;
  source: string;
  disclosure: string;
  rows: GinBenchmarkRow[];
}

export const ginBenchmarkFallback: GinBenchmarkSnapshot = {
  status: 'illustrative',
  snapshotAt: null,
  refreshCadence: 'Daily rolling 30-day window once enough cohorts opt in',
  kAnonymity: 8,
  source: 'fallback snapshot',
  disclosure:
    'Sample figures shown for layout while the live cohort accumulates enough opted-in tenants to publish real benchmarks. Real cohort medians and top-quartile values replace these automatically once each (vertical, metric) cohort meets the k-anonymity threshold.',
  rows: [
    { vertical: 'Healthcare', metric: 'After-hours answer rate', cohortAvg: '85%', median: '78%', topQuartile: '94%', cohortSize: 0 },
    { vertical: 'Dental', metric: 'Booking conversion', cohortAvg: '58%', median: '54%', topQuartile: '71%', cohortSize: 0 },
    { vertical: 'Field service', metric: 'Average call duration', cohortAvg: '5m 30s', median: '7m 30s', topQuartile: '3m 10s', cohortSize: 0 },
    { vertical: 'Real estate', metric: 'Lead-to-tour rate', cohortAvg: '32%', median: '29%', topQuartile: '46%', cohortSize: 0 },
  ],
};
