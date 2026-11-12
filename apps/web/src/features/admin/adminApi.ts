import type {
  AuditEntryDto,
  DeviceDto,
  ResetCodeResponse,
  RoleDto,
  RolePermissionDto,
  SessionDto,
  UserDto,
  UserStatus,
} from '@tradex/contracts';
import { api, type ApiResult } from '../../lib/api';

/** Typed calls for the administration screens (INTERFACES §2 identity rows). */

export interface UserFilter {
  q: string;
  status: UserStatus | '';
}

export interface AuditFilter {
  entityType: string;
  action: string;
}

export const adminKeys = {
  users: (filter: UserFilter) => ['admin', 'users', filter] as const,
  user: (id: string) => ['admin', 'user', id] as const,
  sessions: (userId: string) => ['admin', 'user', userId, 'sessions'] as const,
  devices: (userId: string) => ['admin', 'user', userId, 'devices'] as const,
  roles: ['admin', 'roles'] as const,
  audit: (filter: AuditFilter) => ['admin', 'audit', filter] as const,
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export const PAGE_SIZE = 50;

export function listUsers(filter: UserFilter, after?: string): Promise<ApiResult<UserDto[]>> {
  return api.get<UserDto[]>(
    `/users${query({ q: filter.q, status: filter.status, limit: PAGE_SIZE, after })}`,
  );
}

export async function getUser(id: string): Promise<UserDto> {
  return (await api.get<UserDto>(`/users/${id}`)).data;
}

export interface RoleAssignmentBody {
  roleId: string;
  divisionId: string | null;
}

export interface CreateUserBody {
  username: string;
  displayName: string;
  phone?: string | null;
  password: string;
  roles: RoleAssignmentBody[];
}

export async function createUser(body: CreateUserBody): Promise<UserDto> {
  return (await api.post<UserDto>('/users', body)).data;
}

export interface UpdateUserBody {
  displayName?: string;
  phone?: string | null;
  status?: 'ACTIVE' | 'DISABLED';
  roles?: RoleAssignmentBody[];
}

export async function updateUser(id: string, body: UpdateUserBody): Promise<UserDto> {
  return (await api.patch<UserDto>(`/users/${id}`, body)).data;
}

export async function unlockUser(id: string): Promise<void> {
  await api.post(`/users/${id}/unlock`);
}

/** The code comes back once. Callers keep it in component state only (never in a query cache). */
export async function issueResetCode(id: string): Promise<ResetCodeResponse> {
  return (await api.post<ResetCodeResponse>(`/users/${id}/reset-code`)).data;
}

export async function listUserSessions(id: string): Promise<SessionDto[]> {
  return (await api.get<SessionDto[]>(`/users/${id}/sessions`)).data;
}

export async function revokeAllUserSessions(id: string): Promise<void> {
  await api.delete(`/users/${id}/sessions`);
}

export async function revokeSession(id: string): Promise<void> {
  await api.delete(`/sessions/${id}`);
}

export async function listUserDevices(id: string): Promise<DeviceDto[]> {
  return (await api.get<DeviceDto[]>(`/users/${id}/devices`)).data;
}

export async function revokeDevice(id: string): Promise<void> {
  await api.post(`/devices/${id}/revoke`);
}

export async function listRoles(): Promise<RoleDto[]> {
  return (await api.get<RoleDto[]>('/roles')).data;
}

export async function createRole(body: {
  code: string;
  name: string;
  permissions: RolePermissionDto[];
}): Promise<RoleDto> {
  return (await api.post<RoleDto>('/roles', body)).data;
}

export async function updateRole(
  id: string,
  body: { name?: string; permissions?: RolePermissionDto[] },
): Promise<RoleDto> {
  return (await api.patch<RoleDto>(`/roles/${id}`, body)).data;
}

export function listAudit(
  filter: AuditFilter,
  before?: string,
): Promise<ApiResult<AuditEntryDto[]>> {
  return api.get<AuditEntryDto[]>(
    `/audit${query({
      entityType: filter.entityType.trim(),
      action: filter.action.trim(),
      limit: PAGE_SIZE,
      before,
    })}`,
  );
}
