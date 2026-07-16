export type PublicFrameworkStatus = 'not_verified';

export interface PublicComplianceFramework {
  key: string;
  name: string;
  status: PublicFrameworkStatus;
  status_label: string;
  scope: string;
  description: string;
  evidence_url: string | null;
  last_reviewed: string;
}

export interface PublicPostureSubprocessor {
  id: string;
  name: string;
  purpose: string;
  data_types: string;
  location: string;
  website: string | null;
}

export const PUBLIC_COMPLIANCE_FRAMEWORKS: ReadonlyArray<
  Omit<PublicComplianceFramework, 'last_reviewed'>
> = [
  {
    key: 'soc2',
    name: 'SOC 2 Type II',
    status: 'not_verified',
    status_label: 'Not attested',
    scope: 'No attestation recorded',
    description:
      'QVO has not recorded an independent SOC 2 attestation. Do not treat roadmap or readiness work as certification evidence.',
    evidence_url: null,
  },
  {
    key: 'hipaa',
    name: 'HIPAA',
    status: 'not_verified',
    status_label: 'Pilot approval pending',
    scope: 'PHI use is not approved',
    description:
      'Healthcare pilots remain synthetic-data-only until QVO, the customer, and every required vendor agreement and configuration are approved in writing.',
    evidence_url: null,
  },
  {
    key: 'gdpr',
    name: 'GDPR',
    status: 'not_verified',
    status_label: 'Legal review pending',
    scope: 'No compliance determination recorded',
    description:
      'Privacy workflows exist in the product, but legal review, transfer terms, deployment configuration, and operating evidence have not been approved as a complete GDPR program.',
    evidence_url: null,
  },
  {
    key: 'ccpa',
    name: 'CCPA / CPRA',
    status: 'not_verified',
    status_label: 'Legal review pending',
    scope: 'No compliance determination recorded',
    description:
      'Product access and deletion workflows do not by themselves establish legal compliance. The applicable business practices and notices require owner review.',
    evidence_url: null,
  },
  {
    key: 'iso27001',
    name: 'ISO 27001',
    status: 'not_verified',
    status_label: 'Not certified',
    scope: 'No certification recorded',
    description: 'QVO has not recorded an ISO 27001 certification or certified scope.',
    evidence_url: null,
  },
];

export function buildPublicCompliancePosture(
  subprocessors: PublicPostureSubprocessor[],
  now = new Date(),
) {
  const reviewed = now.toISOString().slice(0, 10);
  return {
    version: 1 as const,
    generated_at: now.toISOString(),
    organization: {
      name: 'QVO — Quality Voice Operations',
      contact_security: '/contact',
      contact_privacy: '/contact',
    },
    frameworks: PUBLIC_COMPLIANCE_FRAMEWORKS.map((framework) => ({
      ...framework,
      last_reviewed: reviewed,
    })),
    baa: {
      available: false,
      plans: [] as string[],
      contact: '/contact',
      notes:
        'No executed QVO healthcare-pilot BAA or complete vendor BAA chain is recorded in this repository. PHI processing is not approved until the named owner verifies all required agreements and configurations.',
    },
    data_residency: {
      verified: false,
      primary_region: 'Not contractually committed',
      description:
        'The production hosting region, backup locations, failover locations, and vendor processing regions require contract and deployment evidence before a residency commitment can be published.',
    },
    subprocessors,
    documents: [
      { name: 'Data Processing Addendum (draft template)', url: '/legal/dpa', kind: 'dpa' as const },
      { name: 'Sub-processor list', url: '/subprocessors', kind: 'list' as const },
      { name: 'Privacy policy', url: '/privacy', kind: 'page' as const },
      { name: 'Security evidence state', url: '/security', kind: 'page' as const },
    ],
  };
}
