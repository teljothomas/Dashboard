import { z } from 'zod';
import { Uuid } from './common.js';

/** INTERFACES section 2 (identity) wire contract. Row scopes per INTERFACES section 3. */

export const SCOPE_VALUES = ['OWN', 'DIVISION', 'ALL'] as const;
export const GrantScope = z.enum(SCOPE_VALUES);
export type GrantScope = z.infer<typeof GrantScope>;

/** One permission the caller holds. `divisionId` is the division limiter of the role assignment. */
export const PermissionGrantDto = z.object({
  permission: z.string().min(1),
  scope: GrantScope,
  divisionId: Uuid.nullable(),
});
export type PermissionGrantDto = z.infer<typeof PermissionGrantDto>;

export const LoginRequest = z.object({
  username: z.string().min(1).max(128),
  // Upper bound only: policy is checked on set, never on login (so old passwords still work).
  password: z.string().min(1).max(256),
  deviceId: Uuid,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

export const SessionUserDto = z.object({
  id: Uuid,
  username: z.string(),
  displayName: z.string(),
  mustChangePassword: z.boolean(),
});
export type SessionUserDto = z.infer<typeof SessionUserDto>;

/** Body of `POST /auth/login` and `GET /auth/me` (inside `{ data }`). */
export const SessionInfo = z.object({
  user: SessionUserDto,
  roles: z.array(z.string()),
  permissions: z.array(PermissionGrantDto),
  csrfToken: z.string().min(1),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

// ---------------------------------------------------------------------------
// WP-04.4: user and role management, password reset, sessions, devices, audit view.
// ---------------------------------------------------------------------------

export const USER_STATUS_VALUES = ['ACTIVE', 'DISABLED', 'LOCKED'] as const;
export const UserStatus = z.enum(USER_STATUS_VALUES);
export type UserStatus = z.infer<typeof UserStatus>;

/** Statuses an administrator may set (LOCKED is reserved and never set by the API). */
export const SettableUserStatus = z.enum(['ACTIVE', 'DISABLED']);
export type SettableUserStatus = z.infer<typeof SettableUserStatus>;

/** One role assignment. `divisionId` null means no division limiter. */
export const RoleAssignmentInput = z.object({
  roleId: Uuid,
  divisionId: Uuid.nullable().default(null),
});
export type RoleAssignmentInput = z.infer<typeof RoleAssignmentInput>;

export const RoleAssignmentDto = z.object({
  roleId: Uuid,
  roleCode: z.string(),
  roleName: z.string(),
  divisionId: Uuid.nullable(),
});
export type RoleAssignmentDto = z.infer<typeof RoleAssignmentDto>;

export const UserDto = z.object({
  id: Uuid,
  username: z.string(),
  displayName: z.string(),
  phone: z.string().nullable(),
  status: UserStatus,
  mustChangePassword: z.boolean(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  roles: z.array(RoleAssignmentDto),
});
export type UserDto = z.infer<typeof UserDto>;

const DisplayName = z.string().trim().min(1).max(120);
const Phone = z.string().trim().min(5).max(32);

/** Admin supplies a temporary password; the user must change it at first login. */
export const CreateUserRequest = z.object({
  username: z.string().min(1).max(64),
  displayName: DisplayName,
  phone: Phone.nullable().optional(),
  password: z.string().min(1).max(256),
  roles: z.array(RoleAssignmentInput).max(20).default([]),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

/** Every field optional; `roles` replaces the whole assignment set when present. */
export const UpdateUserRequest = z
  .object({
    displayName: DisplayName.optional(),
    phone: Phone.nullable().optional(),
    status: SettableUserStatus.optional(),
    roles: z.array(RoleAssignmentInput).max(20).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Nothing to update',
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const ListUsersQuery = z.object({
  status: UserStatus.optional(),
  q: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: Uuid.optional(),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuery>;

/** Body of `POST /users/:id/reset-code` (inside `{ data }`). The code is shown once. */
export const ResetCodeResponse = z.object({
  code: z.string(),
  expiresAt: z.string(),
});
export type ResetCodeResponse = z.infer<typeof ResetCodeResponse>;

export const ResetCompleteRequest = z.object({
  username: z.string().min(1).max(128),
  code: z.string().min(1).max(32),
  newPassword: z.string().min(1).max(256),
});
export type ResetCompleteRequest = z.infer<typeof ResetCompleteRequest>;

export const RolePermissionDto = z.object({
  permission: z.string().min(1),
  scope: GrantScope,
});
export type RolePermissionDto = z.infer<typeof RolePermissionDto>;

export const RoleDto = z.object({
  id: Uuid,
  code: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(RolePermissionDto),
});
export type RoleDto = z.infer<typeof RoleDto>;

const RoleName = z.string().trim().min(1).max(80);

export const CreateRoleRequest = z.object({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Role code: uppercase letters, digits and underscore'),
  name: RoleName,
  permissions: z.array(RolePermissionDto).max(100),
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;

/** `permissions` replaces the whole set when present. System roles refuse every update. */
export const UpdateRoleRequest = z
  .object({
    name: RoleName.optional(),
    permissions: z.array(RolePermissionDto).max(100).optional(),
  })
  .refine((body) => body.name !== undefined || body.permissions !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequest>;

export const SessionDto = z.object({
  id: Uuid,
  userId: Uuid,
  deviceId: Uuid.nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
});
export type SessionDto = z.infer<typeof SessionDto>;

export const DeviceDto = z.object({
  id: Uuid,
  userId: Uuid,
  label: z.string().nullable(),
  platform: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSyncAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type DeviceDto = z.infer<typeof DeviceDto>;

export const AuditQuery = z.object({
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(64).optional(),
  actorUserId: Uuid.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Keyset cursor: return rows with an id below this one (newest first). */
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditEntryDto = z.object({
  id: z.string(),
  at: z.string(),
  actorUserId: Uuid.nullable(),
  deviceId: Uuid.nullable(),
  requestId: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDto>;
