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

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; locale: Locale; auth?: boolean },
): Promise<T> {
  const headers: Record<string, string> = { 'x-locale': opts.locale };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const token = opts.auth === false ? null : getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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
