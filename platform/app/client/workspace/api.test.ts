import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { api, setCsrf } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setCsrf(''); });

test('api keeps JSON GET requests and response values unchanged', async () => {
  globalThis.fetch = async (path, init) => {
    assert.equal(path, '/api/fixture');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    return Response.json({ value: 'fixture' });
  };
  assert.deepEqual(await api<{ value: string }>('/api/fixture'), { value: 'fixture' });
});

test('api retrieves CSRF before mutations and preserves method and JSON body', async () => {
  const calls: string[] = [];
  setCsrf('');
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    if (path === '/api/session') return Response.json({ csrfToken: 'fixture-token' });
    assert.equal(init?.method, 'PATCH');
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'fixture-token');
    assert.equal(init?.body, '{"expectedVersion":2,"status":"ready"}');
    return Response.json({ version: 3 });
  };
  await api('/api/fixture', { expectedVersion: 2, status: 'ready' }, 'PATCH');
  await api('/api/fixture', { expectedVersion: 2, status: 'ready' }, 'PATCH');
  assert.deepEqual(calls, ['/api/session', '/api/fixture', '/api/fixture']);
});

test('api preserves error, message, and HTTP-status error precedence', async () => {
  for (const [body, message] of [
    [{ error: 'specific error', message: 'secondary' }, 'specific error'],
    [{ error: '', message: 'secondary' }, 'secondary'],
    [{}, 'Request failed (409)'],
  ] as const) {
    globalThis.fetch = async () => Response.json(body, { status: 409 });
    await assert.rejects(api('/api/fixture'), { message });
  }
  globalThis.fetch = async () => new Response('not JSON', { status: 503 });
  await assert.rejects(api('/api/fixture'), { message: 'Request failed (503)' });
});

test('api repeats a read whose JSON was cut off, but never replays a write', async () => {
  const full = JSON.stringify({ items: ['a', 'b'] });
  const cut = full.slice(0, 12);
  let calls = 0;
  globalThis.fetch = async () => new Response(++calls === 1 ? cut : full);
  assert.deepEqual(await api('/api/state'), { items: ['a', 'b'] });
  assert.equal(calls, 2);

  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(cut); };
  await assert.rejects(api('/api/state'), { message: "The server's reply was cut off before it finished. Try again." });
  assert.equal(calls, 2);

  setCsrf('fixture-token');
  calls = 0;
  await assert.rejects(api('/api/fixture', { value: 1 }), { message: /Check whether the change was saved/ });
  assert.equal(calls, 1);
});

test('api preserves request options and supports raw responses', async () => {
  const controller = new AbortController();
  globalThis.fetch = async (path, init) => {
    assert.equal(path, '/api/raw');
    assert.equal(init?.method, 'GET');
    assert.deepEqual(init?.headers, { Accept: 'application/json' });
    assert.equal(init?.signal, controller.signal);
    return new Response('custom response', { status: 418 });
  };
  const raw = await api('/api/raw', undefined, undefined, {
    headers: { Accept: 'application/json' },
    responseType: 'response',
    signal: controller.signal,
  });
  assert.equal(raw.status, 418);
  assert.equal(await raw.text(), 'custom response');

  globalThis.fetch = async (path, init) => {
    assert.equal(path, '/api/text');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.headers, undefined);
    assert.equal(init?.signal, undefined);
    return new Response('text response');
  };
  assert.equal(
    await api('/api/text', undefined, undefined, { responseType: 'response' }).then((response) => {
      assert.equal(response.status, 200);
      return response.text();
    }),
    'text response',
  );
});

test('api refreshes an expired token once and preserves the rejected mutation', async () => {
  setCsrf('old-token');
  const calls: string[] = [];
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    if (path === '/api/session') return Response.json({ csrfToken: 'new-token' });
    assert.equal(init?.method, 'PATCH');
    assert.equal(init?.body, '{"value":2}');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('X-Fixture'), 'kept');
    if (headers.get('X-CSRF-Token') === 'old-token') return Response.json({ code: 'CSRF_TOKEN_INVALID', error: 'Missing or invalid CSRF token' }, { status: 403 });
    assert.equal(headers.get('X-CSRF-Token'), 'new-token');
    return Response.json({ saved: true });
  };
  const result = await api('/api/fixture', { value: 2 }, 'PATCH', { headers: { 'X-Fixture': 'kept' }, responseType: 'response' });
  assert.deepEqual(await result.json(), { saved: true });
  assert.deepEqual(calls, ['/api/fixture', '/api/session', '/api/fixture']);
});

test('api shares token refresh between concurrent rejected writes', async () => {
  setCsrf('old'); let sessions = 0, writes = 0;
  globalThis.fetch = async (path, init) => {
    if (path === '/api/session') { sessions++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json({ csrfToken: 'new' }); }
    writes++;
    if (new Headers(init?.headers).get('X-CSRF-Token') === 'old') return Response.json({ code: 'CSRF_TOKEN_INVALID' }, { status: 403 });
    return Response.json({ saved: true });
  };
  await Promise.all([api('/api/one', {}), api('/api/two', {})]);
  assert.equal(sessions, 1); assert.equal(writes, 4);
});

test('api never retries network errors, unrelated forbidden writes, or repeated CSRF rejection', async () => {
  for (const kind of ['network', 'forbidden', 'csrf']) {
    setCsrf('token'); let writes = 0;
    globalThis.fetch = async path => {
      if (path === '/api/session') return Response.json({ csrfToken: 'renewed' });
      writes++;
      if (kind === 'network') throw new Error('offline');
      return Response.json(kind === 'csrf' ? { code: 'CSRF_TOKEN_INVALID', error: 'Missing or invalid CSRF token' } : { error: 'Forbidden' }, { status: 403 });
    };
    await assert.rejects(api('/api/mutation', {}));
    assert.equal(writes, kind === 'csrf' ? 2 : 1);
  }
});
