import { clearAccessResolvers, link, registerAccessResolver } from './service.js';

/** `core.attachments` (INTERFACES section 7). */
export const attachments = { link, registerAccessResolver, clearAccessResolvers };

export { registerAttachmentRoutes } from './routes.js';
export {
  LINK_ROLES,
  canRead,
  saveUpload,
  type AccessResolver,
  type LinkRole,
  type StoredAttachment,
} from './service.js';
export { MAX_ATTACHMENT_BYTES, processUpload, sniffType, type AttachmentMime } from './sniff.js';
export { LocalFsStorage, storageKeyFor, type StorageAdapter } from './storage.js';
