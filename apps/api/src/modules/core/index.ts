import * as audit from './audit.js';
import * as jobs from './jobs.js';
import * as notifications from './notifications.js';
import * as numbers from './numbers.js';
import * as settings from './settings.js';

/** Core service interface (INTERFACES section 7). Attachments arrive in WP-03.3. */
export const core = { audit, numbers, jobs, settings, notifications };

export { audit, jobs, notifications, numbers, settings };
export { getContext, runWithContext, type ActorContext, type Tx } from './context.js';
