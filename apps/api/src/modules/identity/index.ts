export {
  defaultGrants,
  PERMISSIONS,
  ROLE_CODES,
  SCOPES,
  SYSTEM_ROLES,
  type Permission,
  type RoleCode,
  type Scope,
} from './catalogue.js';
export {
  ARGON2_PARAMS,
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  PASSWORD_MIN_LENGTH,
  PASSWORD_PROBLEM_MESSAGE,
  verifyPassword,
  type PasswordProblem,
} from './password.js';
export { seedIdentity, type SeedResult } from './seed.js';
export {
  createOwner,
  normalizeUsername,
  type CreatedUser,
  type CreateOwnerInput,
} from './users.js';
export {
  changePassword,
  INVALID_CREDENTIALS_MESSAGE,
  loadSessionInfo,
  login,
  LOGIN_MAX_FAILURES_PER_IP,
  LOGIN_MAX_FAILURES_PER_USERNAME,
  LOGIN_WINDOW_MINUTES,
  logout,
} from './auth.js';
export { registerIdentityRoutes } from './routes.js';
export {
  ABSOLUTE_EXPIRY_DAYS,
  csrfTokenFor,
  hashToken,
  IDLE_EXPIRY_DAYS,
  loadGrants,
  resolveSession,
  revokeSession,
  revokeUserSessions,
  safeEqual,
} from './sessions.js';
export { registerAdminRoutes } from './adminRoutes.js';
export {
  completePasswordReset,
  createUser,
  generateResetCode,
  getUser,
  hashResetCode,
  issueResetCode,
  listUsers,
  normalizeResetCode,
  RESET_CODE_LENGTH,
  RESET_CODE_TTL_MINUTES,
  unlockUser,
  updateUser,
  type Caller,
} from './adminUsers.js';
export { createRole, getRole, listRoles, updateRole } from './roles.js';
export {
  listUserDevices,
  listUserSessions,
  revokeAllUserSessions,
  revokeDevice,
  revokeSessionById,
} from './adminSessions.js';
export { listAudit } from './auditView.js';
