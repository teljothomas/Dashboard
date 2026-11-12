import type { Selectable } from 'kysely';
import type { CreateCompanyRequest, ObservedCompany, TallyCompanyDto } from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import type { Database } from '../../db/index.js';
import type { TallyCompany } from '../../db/generated.js';
import { AppError } from '../../errors.js';
import * as audit from '../core/audit.js';
import type { ActorContext } from '../core/context.js';
import { dateOnly } from './dates.js';
import { sha256Hex } from './signature.js';

/** Name comparison ignores case and runs of whitespace (BR-020). */
export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface CompanyIdentity {
  tallyName: string;
  companyNumber: string;
  booksFrom: string;
  guid?: string | null | undefined;
}

/** sha256(normalised name|number|books_from|guid-if-available) as hex (DATA_MODEL section 4). */
export function companyFingerprint(identity: CompanyIdentity): string {
  return sha256Hex(
    [
      normaliseName(identity.tallyName),
      identity.companyNumber.trim(),
      identity.booksFrom,
      (identity.guid ?? '').trim().toLowerCase(),
    ].join('|'),
  );
}

/**
 * Does what the agent observed in Tally match what the admin registered? Name and books-from always
 * count; the company number counts when the admin entered one; the guid counts when both sides have it
 * (TALLY_INTEGRATION section 8 item a: company info is NOT VERIFIED, so the guid may be unknown).
 */
export function identityMatches(expected: CompanyIdentity, observed: ObservedCompany): boolean {
  if (normaliseName(expected.tallyName) !== normaliseName(observed.tallyName)) return false;
  if (expected.booksFrom !== observed.booksFrom) return false;
  const expectedNumber = expected.companyNumber.trim();
  if (expectedNumber !== '' && expectedNumber !== observed.companyNumber.trim()) return false;
  if (
    expected.guid &&
    observed.guid &&
    expected.guid.trim().toLowerCase() !== observed.guid.trim().toLowerCase()
  ) {
    return false;
  }
  return true;
}

export function toCompanyDto(row: Selectable<TallyCompany>): TallyCompanyDto {
  return {
    id: row.id,
    displayName: row.display_name,
    tallyName: row.tally_name,
    companyNumber: row.company_number,
    booksFrom: dateOnly(row.books_from),
    tallyGuid: row.tally_guid,
    fingerprint: row.fingerprint,
    isTest: row.is_test,
    postingMode: row.posting_mode as TallyCompanyDto['postingMode'],
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

export async function createCompany(
  db: Database,
  input: CreateCompanyRequest,
  actor: ActorContext & { userId: string },
): Promise<TallyCompanyDto> {
  const fingerprint = companyFingerprint({
    tallyName: input.tallyName,
    companyNumber: input.companyNumber,
    booksFrom: input.booksFrom,
    guid: input.tallyGuid,
  });
  return db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom('tally_company')
      .select('id')
      .where('fingerprint', '=', fingerprint)
      .executeTakeFirst();
    if (existing) {
      throw new AppError('VALIDATION_FAILED', 'This Tally company is already registered', {
        fields: [{ path: 'tallyName', message: 'already registered' }],
      });
    }
    const row = await tx
      .insertInto('tally_company')
      .values({
        id: uuidv7(),
        display_name: input.displayName,
        tally_name: input.tallyName.trim(),
        company_number: input.companyNumber.trim(),
        books_from: input.booksFrom,
        tally_guid: input.tallyGuid,
        fingerprint,
        is_test: input.isTest,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit.record(tx, {
      action: 'tally.company.create',
      entityType: 'tally_company',
      entityId: row.id,
      after: {
        displayName: row.display_name,
        tallyName: row.tally_name,
        companyNumber: row.company_number,
        booksFrom: row.books_from,
        isTest: row.is_test,
      },
      ctx: actor,
    });
    return toCompanyDto(row);
  });
}

export async function listCompanies(db: Database): Promise<TallyCompanyDto[]> {
  const rows = await db
    .selectFrom('tally_company')
    .selectAll()
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toCompanyDto);
}

/** Server side of `POST /company/verify`: the match flag and the fingerprint the agent then leases with. */
export async function verifyObserved(
  db: Database,
  companyId: string,
  observed: ObservedCompany,
): Promise<{ match: boolean; fingerprint: string }> {
  const company = await db
    .selectFrom('tally_company')
    .select(['tally_name', 'company_number', 'books_from', 'tally_guid', 'fingerprint'])
    .where('id', '=', companyId)
    .executeTakeFirstOrThrow();
  const match = identityMatches(
    {
      tallyName: company.tally_name,
      companyNumber: company.company_number,
      booksFrom: dateOnly(company.books_from),
      guid: company.tally_guid,
    },
    observed,
  );
  return {
    match,
    fingerprint: match ? company.fingerprint : companyFingerprint(observed),
  };
}
