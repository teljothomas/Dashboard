import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ERROR_HTTP_STATUS, type ErrorCode } from '@tradex/contracts';
import { AppError, toEnvelope } from '../errors.js';

/** Fixed, non-leaky messages per code for errors we did not raise ourselves. */
const GENERIC_MESSAGES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'Request validation failed',
  NOT_FOUND: 'Resource not found',
  PAYLOAD_TOO_LARGE: 'Request payload too large',
  UNSUPPORTED_MEDIA: 'Unsupported media type',
  RATE_LIMITED: 'Too many requests',
  INTERNAL: 'Internal server error',
};

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 400 && status < 500 ? 'VALIDATION_FAILED' : 'INTERNAL';
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(ERROR_HTTP_STATUS.NOT_FOUND)
      .send(toEnvelope('NOT_FOUND', 'Resource not found', request.id));
  });

  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      request.log.info({ code: error.code }, 'request failed');
      return reply
        .code(error.httpStatus)
        .send(toEnvelope(error.code, error.message, request.id, error.details));
    }

    if (error instanceof ZodError) {
      const fields = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return reply.code(ERROR_HTTP_STATUS.VALIDATION_FAILED).send(
        toEnvelope('VALIDATION_FAILED', GENERIC_MESSAGES.VALIDATION_FAILED ?? '', request.id, {
          fields,
        }),
      );
    }

    const status = error.statusCode ?? 500;
    const code = codeForStatus(status);
    if (code === 'INTERNAL') {
      // Details stay in the log; the client only gets the request id.
      request.log.error({ err: error }, 'unhandled error');
    } else {
      request.log.info({ code, fastifyCode: error.code }, 'request rejected');
    }
    return reply
      .code(ERROR_HTTP_STATUS[code])
      .send(toEnvelope(code, GENERIC_MESSAGES[code] ?? 'Request failed', request.id));
  });
}
