import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../../errors.js';
import { actorOf, requireContext } from '../../../plugins/requestContext.js';
import { canRead, saveUpload } from './service.js';
import { MAX_ATTACHMENT_BYTES, processUpload } from './sniff.js';
import type { StorageAdapter } from './storage.js';

/** Multipart framing overhead allowed on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

const IdParam = z.object({ id: z.uuid() });

/** `attachment; filename="ascii"; filename*=UTF-8''percent-encoded` (RFC 6266 / 5987). */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * POST /api/v1/attachments and GET /api/v1/attachments/:id (INTERFACES section 2).
 * Both require an authenticated request context (the auth seam, Phase 04).
 */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  options: { storage: StorageAdapter },
): void {
  const { storage } = options;

  app.register(
    (api, _opts, done) => {
      void api.register(multipart, {
        limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6 },
      });

      api.post(
        '/attachments',
        { bodyLimit: MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES },
        async (request, reply) => {
          const ctx = requireContext(request);
          if (!request.isMultipart()) {
            throw new AppError('UNSUPPORTED_MEDIA', 'Expected multipart/form-data', {
              reason: 'not-multipart',
            });
          }
          // Walk every part so a second file is rejected instead of silently ignored. Plain form
          // fields are skipped. `toBuffer` throws FST_REQ_FILE_TOO_LARGE (413) over the size limit.
          let raw: Buffer | undefined;
          let filename: string | undefined;
          try {
            for await (const part of request.parts()) {
              if (part.type !== 'file') continue;
              if (raw) {
                throw new AppError('VALIDATION_FAILED', 'Exactly one file is allowed', {
                  fields: { file: 'too-many' },
                });
              }
              filename = part.filename;
              raw = await part.toBuffer();
            }
          } catch (err) {
            if (
              typeof err === 'object' &&
              err !== null &&
              'code' in err &&
              err.code === 'FST_FILES_LIMIT'
            ) {
              throw new AppError('VALIDATION_FAILED', 'Exactly one file is allowed', {
                fields: { file: 'too-many' },
              });
            }
            throw err;
          }
          if (!raw) {
            throw new AppError('VALIDATION_FAILED', 'No file in request', {
              fields: { file: 'required' },
            });
          }
          const upload = await processUpload(raw);
          const stored = await saveUpload(app.db, storage, upload, {
            originalName: filename,
            uploadedBy: ctx.userId,
            deviceId: ctx.deviceId,
            ctx: actorOf(request, ctx),
          });
          return reply
            .code(stored.created ? 201 : 200)
            .send({ id: stored.id, sha256: stored.sha256 });
        },
      );

      api.get('/attachments/:id', async (request, reply) => {
        const ctx = requireContext(request);
        const parsed = IdParam.safeParse(request.params);
        // Not-found for every refusal: no hint whether an id exists to someone who may not read it.
        if (!parsed.success) {
          throw new AppError('NOT_FOUND', 'Attachment not found');
        }
        const row = await app.db
          .selectFrom('attachment')
          .selectAll()
          .where('id', '=', parsed.data.id)
          .executeTakeFirst();
        if (!row || !row.scanned_ok || !(await canRead(app.db, ctx, row))) {
          throw new AppError('NOT_FOUND', 'Attachment not found');
        }

        const stream = await storage.open(row.storage_key);
        const isImage = row.mime.startsWith('image/');
        return reply
          .header('Content-Type', row.mime)
          .header('Content-Length', String(row.size_bytes))
          .header(
            'Content-Disposition',
            contentDisposition(isImage ? 'inline' : 'attachment', row.original_name),
          )
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'private, no-store')
          .send(stream);
      });

      done();
    },
    { prefix: '/api/v1' },
  );
}
