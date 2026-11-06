/**
 * How the Desk's server talks to core. The token stays in this process: the page only ever sees the
 * Desk's own routes, because the same token authorises /v1/check and cancelling requests.
 */

export type CoreAnswer = { status: number; body: string; contentType: string };

/** Everything the Desk needs from core. Fixture mode swaps in a synthetic one and nothing else changes. */
export interface CoreSource {
  get(path: string): Promise<CoreAnswer>;
  post(path: string, body: unknown): Promise<CoreAnswer>;
}

export class CoreUnavailable extends Error {}

/** Long enough for a healthy local core, short enough that the page shows the failure while it matters. */
const TIMEOUT_MS = 3000;

export function httpCore(options: { url: string; token: string; fetchImpl?: typeof fetch }): CoreSource {
  const { url, token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  const call = async (path: string, init: RequestInit): Promise<CoreAnswer> => {
    let res: Response;
    try {
      res = await fetchImpl(`${url}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // The cause can carry the request, so it stays out of the message.
      throw new CoreUnavailable(`Core is not answering at ${url}. Start the stack with: just demo. To look around without it, on labelled synthetic data: pnpm desk:fixture.`);
    }
    return { status: res.status, body: await res.text(), contentType: res.headers.get("content-type") ?? "application/json" };
  };

  return {
    get: (path) => call(path, { method: "GET" }),
    post: (path, body) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}
