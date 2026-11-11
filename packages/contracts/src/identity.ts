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
