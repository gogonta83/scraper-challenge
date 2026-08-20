import axios from 'axios';

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryOptions = {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

function normalizeHeaders(headers: unknown): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  if (!headers || typeof headers !== 'object') return result;

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'string' || Array.isArray(value)) {
      result[key] = value;
    } else if (value != null) {
      result[key] = String(value);
    }
  }

  return result;
}

export async function requestWithRetry(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    data?: string;
    responseType?: 'text' | 'arraybuffer';
    cookie?: string;
    cookieJar?: { value: string };
    retry: RetryOptions;
  }
): Promise<{ status: number; headers: Record<string, string | string[]>; data: Buffer }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retry.retries; attempt += 1) {
    try {
      const cookieValue = options.cookieJar?.value ?? options.cookie;
      const response = await axios.request({
        url,
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          ...(cookieValue ? { cookie: cookieValue } : {}),
        },
        data: options.data,
        // Always request raw bytes: axios would otherwise decode text using the
        // declared charset and mangle Latin-1 titles like "Análisis" into "An�lisis".
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });

      if (response.status !== 429) {
        mergeSetCookies(response.headers, options.cookieJar);
        return {
          status: response.status,
          headers: normalizeHeaders(response.headers),
          data: response.data,
        };
      }

      if (attempt === options.retry.retries) {
        mergeSetCookies(response.headers, options.cookieJar);
        return {
          status: response.status,
          headers: normalizeHeaders(response.headers),
          data: response.data,
        };
      }

      const retryAfter = Number(response.headers['retry-after'] ?? NaN);
      const backoffMs = Math.min(options.retry.maxDelayMs, options.retry.baseDelayMs * 2 ** attempt);
      await sleep(Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, backoffMs));
    } catch (error) {
      lastError = error;
      if (attempt === options.retry.retries) throw error;
      const backoffMs = Math.min(options.retry.maxDelayMs, options.retry.baseDelayMs * 2 ** attempt);
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Request failed');
}

export function decodeText(data: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    // The portal declares charset=ISO-8859-1 but sends single-byte Latin-1 text.
    return new TextDecoder('windows-1252').decode(data);
  }
}

function mergeSetCookies(
  headers: Record<string, unknown>,
  cookieJar?: { value: string }
): void {
  if (!cookieJar) return;
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw)
    ? raw
    : raw
      ? [raw]
      : [];
  if (values.length === 0) return;

  const entries = new Map<string, string>();
  for (const piece of `${cookieJar.value}; ${values.map((v) => String(v).split(';')[0]).join('; ')}`.split(';')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) entries.set(trimmed.slice(0, eq).trim(), trimmed);
  }
  cookieJar.value = [...entries.values()].join('; ');
}

export async function ensureDirPath(path: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(path, { recursive: true });
}

export function sanitizeFileName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'document';
}
