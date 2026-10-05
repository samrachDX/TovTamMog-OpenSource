import type { Locale } from '@/lib/i18n';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'ttm.session';
let memoryToken: string | null = null;

/** The token lives for the life of the tab only; reopening the Mini App signs in again. */
export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    memoryToken = window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: memory only */
  }
  return memoryToken;
}

export function setToken(token: string | null): void {
  memoryToken = token;
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Signs out here and on the server. The local token goes even if the server cannot be reached. */
export function signOut(): void {
  const token = getToken();
  setToken(null);
  if (token) {
    void fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; locale: Locale; auth?: boolean },
): Promise<T> {
  const headers: Record<string, string> = { 'x-locale': opts.locale };
  // FormData goes as multipart; the browser sets the content type and boundary itself.
  const form = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (opts.body !== undefined && !form) headers['content-type'] = 'application/json';
  const token = opts.auth === false ? null : getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : form ? (opts.body as FormData) : JSON.stringify(opts.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('NETWORK', '', 0, null);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'INTERNAL', err?.message ?? '', res.status, data);
  }
  return data as T;
}

/** Authenticated request for something other than JSON: fetching or uploading a file. */
export async function apiRaw(path: string, opts: { locale: Locale; method?: string; body?: Blob }): Promise<Response> {
  const headers: Record<string, string> = { 'x-locale': opts.locale };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (opts.body ? 'PUT' : 'GET'), headers, body: opts.body, cache: 'no-store' });
  } catch {
    throw new ApiError('NETWORK', '', 0, null);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(data?.error?.code ?? 'INTERNAL', data?.error?.message ?? '', res.status, data);
  }
  return res;
}

/** Scales an image down in the browser and re-encodes it as JPEG, so uploads stay small. */
export async function shrinkImage(file: Blob, maxSide: number, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ApiError('INTERNAL', '', 0, null);
  // White behind transparent PNGs, which JPEG cannot represent.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ApiError('INTERNAL', '', 0, null))), 'image/jpeg', quality),
  );
}
