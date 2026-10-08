/** Fetch wrapper for the JSON API: throws ApiError with the server's message. */

export class ApiError extends Error {
  status: number;
  signedOut: boolean;

  constructor(message: string, status: number, signedOut: boolean) {
    super(message);
    this.status = status;
    this.signedOut = signedOut;
  }
}

let signedOutListener: (() => void) | null = null;
let signedOutAnnounced = false;

/** Called once, the first time GitHub stops accepting the sign-in. */
export function onSignedOut(listener: () => void) {
  signedOutListener = listener;
  signedOutAnnounced = false;
}

export async function request<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((d: { msg: string }) => d.msg).join("; ") : data.detail;
    if (data.signedOut && !signedOutAnnounced) {
      signedOutAnnounced = true;
      signedOutListener?.();
    }
    throw new ApiError(data.error || detail || `Request failed (${res.status})`, res.status, !!data.signedOut);
  }
  return data as T;
}
