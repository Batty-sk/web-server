/**
 * Starts the real app on a free port against a throwaway database, with
 * developer sign-in and billing. Tests talk to it over HTTP like the site does.
 */
import { app } from '../app.js';
import { API_URL, PORT } from '../config.js';
import { migrate } from '../db/schema.js';

export const SITE = 'http://localhost:8080';

await migrate();
// Redirects are built from API_URL, so the server must listen where API_URL says.
const server = app.listen(PORT);
await new Promise((resolve) => server.once('listening', resolve));
export const API = API_URL;
export const stop = () => new Promise((resolve) => server.close(resolve));

/** A browser, reduced to what matters here: cookies, the site's Origin and no automatic redirects. */
export class Browser {
  private cookies = new Map<string, string>();

  private remember(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, ...value] = pair!.split('=');
      if (/Max-Age=0/i.test(header)) this.cookies.delete(name!);
      else this.cookies.set(name!, value.join('='));
    }
  }

  async fetch(url: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (init.origin !== null && init.method && init.method !== 'GET') headers.Origin = init.origin ?? SITE;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'manual',
    });
    this.remember(response);
    return response;
  }

  async json<T = any>(url: string, init: Parameters<Browser['fetch']>[1] = {}): Promise<{ status: number; body: T }> {
    const response = await this.fetch(url, init);
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  /** Signs in through the developer provider, following the same redirects as a real sign-in. */
  async signIn(email: string, mount = '/auth') {
    const start = await this.fetch(`${mount}/dev?email=${encodeURIComponent(email)}&name=${encodeURIComponent(email.split('@')[0]!)}`);
    const callback = await this.fetch(start.headers.get('location')!);
    return callback.headers.get('location');
  }

  /** Buys through the developer checkout: start, then press Subscribe on its page. */
  async subscribe(seats = 1, name = '') {
    const { status, body } = await this.json('/billing/checkout', { method: 'POST', body: { seats, name } });
    if (status !== 200) return { status, body };
    const done = await this.fetch(body.url, { method: 'POST', origin: API });
    return { status: done.status, body: { location: done.headers.get('location') } };
  }
}
