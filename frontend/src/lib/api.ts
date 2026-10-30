import type { BatchResult, FileListing, LogEntry, OperationResult, Op } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError('Bridge unreachable. Is the bridge running on port 7070?', 0, 'ENETWORK');
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error */
  }

  if (!res.ok) {
    const b = body as { error?: string; message?: string; code?: string; status?: string } | null;
    throw new ApiError(b?.message ?? b?.error ?? `Request failed (${res.status})`, res.status, b?.code ?? b?.status, body);
  }

  return body as T;
}

export const api = {
  files: () => call<FileListing>('/api/files'),

  read: (name: string) => call<OperationResult>(`/api/files/${encodeURIComponent(name)}`),

  write: (name: string, content: string) =>
    call<OperationResult>(`/api/files/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  create: (name: string, content?: string) =>
    call<OperationResult & { create?: OperationResult }>('/api/files', {
      method: 'POST',
      body: JSON.stringify({ name, content }),
    }),

  batch: (requests: { op: Op; file: string; content?: string }[]) =>
    call<BatchResult>('/api/batch', { method: 'POST', body: JSON.stringify({ requests }) }),

  logs: (limit = 1500) => call<{ logs: LogEntry[] }>(`/api/logs?limit=${limit}`),
};
