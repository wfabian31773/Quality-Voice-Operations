import medical from './medical.json';
import fieldService from './field-service.json';
import realEstate from './real-estate.json';
import legal from './legal.json';
import restaurant from './restaurant.json';
import general from './general.json';

export type DashboardKpiMetric = 'totalCalls' | 'automationRate' | 'avgDuration' | 'costPerCall';
export type DashboardSection = 'callVolume' | 'callOutcomes' | 'costBreakdown' | 'campaigns' | 'toolReliability';
export type DashboardRange = '7d' | '30d' | '90d';

export interface DashboardKpi {
  metric: DashboardKpiMetric;
  label: string;
}

export interface VerticalDashboard {
  key: string;
  label: string;
  emoji: string;
  description: string;
  industries: string[];
  defaultRange: DashboardRange;
  callsLabel: string;
  contactLabel: string;
  kpis: DashboardKpi[];
  sections: DashboardSection[];
}

const allDashboards = [medical, fieldService, realEstate, legal, restaurant, general] as VerticalDashboard[];

export const dashboards: VerticalDashboard[] = allDashboards;

export const GENERAL_DASHBOARD: VerticalDashboard = general as VerticalDashboard;

export function getDashboardByKey(key: string | null | undefined): VerticalDashboard {
  if (!key) return GENERAL_DASHBOARD;
  const match = dashboards.find((d) => d.key === key);
  return match ?? GENERAL_DASHBOARD;
}

export function pickDashboardForIndustry(industry: string | null | undefined): VerticalDashboard {
  if (!industry) return GENERAL_DASHBOARD;
  const normalized = industry.toLowerCase().trim();
  const match = dashboards.find((d) => d.industries.some((i) => i.toLowerCase() === normalized));
  return match ?? GENERAL_DASHBOARD;
}
