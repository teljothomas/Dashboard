import * as audit from './audit.js';
import { attachments } from './attachments/index.js';
import * as jobs from './jobs.js';
import * as notifications from './notifications.js';
import * as numbers from './numbers.js';
import * as settings from './settings.js';

/** Core service interface (INTERFACES section 7). */
export const core = { audit, numbers, jobs, settings, notifications, attachments };

export { attachments, audit, jobs, notifications, numbers, settings };
export { getContext, runWithContext, type ActorContext, type Tx } from './context.js';
