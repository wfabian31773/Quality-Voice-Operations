import type { RunReport, ScenarioRunResult } from './types';

export function publicReport(report: RunReport): Omit<RunReport, 'results'> & {
  results: Array<Pick<ScenarioRunResult, 'id' | 'status' | 'expectedFail' | 'failures' | 'diff'>>;
} {
  return {
    ...report,
    results: report.results.map((result) => ({
      id: result.id,
      status: result.status,
      expectedFail: result.expectedFail,
      failures: result.failures,
      diff: result.diff,
    })),
  };
}

export function formatHumanSummary(report: RunReport): string {
  const lines = [
    `quality:sim mode=${report.mode} ok=${report.ok}`,
    `  passed: ${report.passed.length} ${report.passed.join(', ') || '—'}`,
    `  failed: ${report.failed.length} ${report.failed.join(', ') || '—'}`,
    `  expectedFail: ${report.expectedFailed.length} ${
      report.expectedFailed.map((row) => `${row.id} (${row.expectedFail})`).join(', ') || '—'
    }`,
    `  unexpectedPass: ${report.unexpectedPassed.length} ${
      report.unexpectedPassed.map((row) => `${row.id} (${row.expectedFail})`).join(', ') || '—'
    }`,
  ];
  for (const result of report.results) {
    if (result.status === 'failed') lines.push(result.diff);
    if (result.status === 'expected_fail') {
      lines.push(`EXPECTED FAIL ${result.id} [${result.expectedFail}]`);
      if (result.diff) lines.push(result.diff.replace(/^FAIL [^\n]+\n/, ''));
    }
    if (result.status === 'unexpected_pass') {
      lines.push(`UNEXPECTED PASS ${result.id} [${result.expectedFail}] — remove expectedFail when the tool ships`);
    }
  }
  return lines.join('\n');
}
