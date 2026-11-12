import type {
  ConnectorAgentDto,
  CreateCompanyRequest,
  RegistrationCodeDto,
  TallyCompanyDto,
  TallyLedgerDto,
  TallyStatusDto,
  TallyVoucherDetailDto,
  TallyVoucherDto,
  VoucherBaseType,
} from '@tradex/contracts';
import { api, type ApiResult } from '../../lib/api';

/** Typed calls for the Tally screens (INTERFACES section 2, tally rows, non-posting). */

export const TALLY_PAGE_SIZE = 50;

export interface LedgerFilter {
  q: string;
  isParty: '' | 'true' | 'false';
}

export interface VoucherFilter {
  q: string;
  baseType: VoucherBaseType | '';
  from: string;
  to: string;
  includeDeleted: boolean;
}

export const tallyKeys = {
  status: ['tally', 'status'] as const,
  companies: ['tally', 'companies'] as const,
  agents: ['tally', 'agents'] as const,
  ledgers: (filter: LedgerFilter) => ['tally', 'ledgers', filter] as const,
  vouchers: (filter: VoucherFilter) => ['tally', 'vouchers', filter] as const,
  voucher: (guid: string) => ['tally', 'voucher', guid] as const,
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export async function getTallyStatus(): Promise<TallyStatusDto> {
  return (await api.get<TallyStatusDto>('/tally/status')).data;
}

export async function listTallyCompanies(): Promise<TallyCompanyDto[]> {
  return (await api.get<TallyCompanyDto[]>('/tally/companies')).data;
}

export type CreateCompanyBody = Pick<
  CreateCompanyRequest,
  'displayName' | 'tallyName' | 'booksFrom' | 'isTest'
> &
  Partial<Pick<CreateCompanyRequest, 'companyNumber' | 'tallyGuid'>>;

export async function createTallyCompany(body: CreateCompanyBody): Promise<TallyCompanyDto> {
  return (await api.post<TallyCompanyDto>('/tally/companies', body)).data;
}

/**
 * The code comes back once and the server marks the response no-store. Callers keep it in
 * component state only (never in a query cache).
 */
export async function issueRegistrationCode(companyId: string): Promise<RegistrationCodeDto> {
  return (await api.post<RegistrationCodeDto>(`/tally/companies/${companyId}/registration-code`))
    .data;
}

export async function listConnectorAgents(): Promise<ConnectorAgentDto[]> {
  return (await api.get<ConnectorAgentDto[]>('/tally/agents')).data;
}

export async function revokeConnectorAgent(id: string): Promise<void> {
  await api.post(`/tally/agents/${id}/revoke`);
}

export function listTallyLedgers(
  filter: LedgerFilter,
  cursor?: string,
): Promise<ApiResult<TallyLedgerDto[]>> {
  return api.get<TallyLedgerDto[]>(
    `/tally/ledgers${query({
      q: filter.q,
      isParty: filter.isParty,
      limit: TALLY_PAGE_SIZE,
      cursor,
    })}`,
  );
}

export function listTallyVouchers(
  filter: VoucherFilter,
  cursor?: string,
): Promise<ApiResult<TallyVoucherDto[]>> {
  return api.get<TallyVoucherDto[]>(
    `/tally/vouchers${query({
      q: filter.q,
      baseType: filter.baseType,
      from: filter.from,
      to: filter.to,
      includeDeleted: filter.includeDeleted ? 'true' : undefined,
      limit: TALLY_PAGE_SIZE,
      cursor,
    })}`,
  );
}

export async function getTallyVoucher(guid: string): Promise<TallyVoucherDetailDto> {
  return (await api.get<TallyVoucherDetailDto>(`/tally/vouchers/${encodeURIComponent(guid)}`)).data;
}
