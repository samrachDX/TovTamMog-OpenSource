const PUBLIC_ID = /^[A-Za-z0-9_-]{12,64}$/;

/** The QR encodes a link whose `b` parameter is the opaque branch identifier. */
export function qrPayload(appUrl: string, publicId: string): string {
  const url = new URL(appUrl);
  url.searchParams.set('b', publicId);
  return url.toString();
}

/** Accepts either the full link or the bare identifier. Returns null when it is neither. */
export function parseQrPayload(scanned: string): string | null {
  const text = scanned.trim();
  if (PUBLIC_ID.test(text)) return text;
  try {
    const id = new URL(text).searchParams.get('b');
    return id && PUBLIC_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}
