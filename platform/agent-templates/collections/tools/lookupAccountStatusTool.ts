import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('COLLECTIONS_ACCOUNT');

export interface LookupAccountStatusInput {
  debtorFirstName?: string;
  debtorLastName: string;
  debtorPhone: string;
  accountNumber?: string;
  lastFourSsn?: string;
}

export interface LookupAccountStatusDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function lookupAccountStatus(
  input: LookupAccountStatusInput,
  deps: LookupAccountStatusDeps,
): Promise<{ success: boolean; message: string; accountId?: string }> {
  logger.info('Account status lookup (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    hasAccountNumber: !!input.accountNumber,
  });

  const accountId = input.accountNumber ?? `ACCT-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    message: `Account ${accountId} has been located. The account details have been loaded for this session.`,
    accountId,
  };
}
