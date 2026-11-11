import Fastify, { type FastifyInstance } from 'fastify';
import type { Writable } from 'node:stream';
import type { AppConfig } from './config.js';
import { createDatabase, isDatabaseHealthy, type Database } from './db/index.js';
import { loggerOptions } from './logger.js';
import {
  LocalFsStorage,
  registerAttachmentRoutes,
  type StorageAdapter,
} from './modules/core/attachments/index.js';
import { registerErrorHandling } from './plugins/errorHandler.js';
import { genRequestId, registerRequestId } from './plugins/requestId.js';
import { registerRequestContext, type RequestContextProvider } from './plugins/requestContext.js';
import { registerSecurityHeaders } from './plugins/securityHeaders.js';

/** Default request body limit (1 MB). Upload routes override later (SECURITY §5). */
export const BODY_LIMIT_BYTES = 1_048_576;

export interface BuildAppOptions {
  /** Test hook: capture log output. */
  logStream?: Writable;
  /** Test hook: use this database instead of creating one from `config.DATABASE_URL`. */
  db?: Database;
  /** Test hook: use this attachment store instead of `LocalFsStorage(config.ATTACHMENTS_DIR)`. */
  storage?: StorageAdapter;
  /**
   * Registers hooks that set `request.ctx`. None in production until WP-04.3, so authenticated
   * routes answer 401. Tests pass a provider from `apps/api/test/`.
   */
  requestContext?: RequestContextProvider;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

/** App factory. No listening here, so tests use `app.inject`. */
export function buildApp(config: AppConfig, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      ...loggerOptions(config.LOG_LEVEL),
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: false,
    genReqId: (req) => genRequestId(req.headers['x-request-id']),
    forceCloseConnections: true,
  });

  registerRequestId(app);
  registerSecurityHeaders(app);
  registerErrorHandling(app);

  // The pool connects lazily, so building the app never needs a reachable database.
  const db = options.db ?? createDatabase(config.DATABASE_URL);
  app.decorate('db', db);
  if (!options.db) {
    app.addHook('onClose', async () => {
      await db.destroy();
    });
  }

  registerRequestContext(app, options.requestContext);
  registerAttachmentRoutes(app, {
    storage: options.storage ?? new LocalFsStorage(config.ATTACHMENTS_DIR),
  });

  // Runs SELECT 1; reports status only (no version or host details, SECURITY).
  app.get('/health', async (_request, reply) => {
    if (await isDatabaseHealthy(db)) {
      return { status: 'ok' };
    }
    return reply.code(503).send({ status: 'error' });
  });

  return app;
}
