import type { Attachment } from '@/lib/requests';

export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

/**
 * Sends a stored attachment back. Never cached by shared caches; the name is passed in an
 * RFC 5987 header so Khmer file names survive.
 */
export function attachmentResponse(file: Attachment): Response {
  return new Response(Buffer.from(file.bytes), {
    headers: {
      'Content-Type': file.contentType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
      // An uploaded PDF opened from here gets no scripts and no access to this site.
      'Content-Security-Policy': FILE_CSP,
    },
  });
}
