import assert from 'node:assert/strict';
import test, { afterEach, after } from 'node:test';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Node'] as const;
const originals = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { renderHook, act, cleanup } = await import('@testing-library/react');
import { useAction } from './workspace';

afterEach(cleanup);
after(() => {
  dom.window.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('useAction preserves direct .message values instead of stringifying throws', async () => {
  const { result } = renderHook(useAction);
  const failures = [
    [new Error('original message'), 'original message'],
    [{ message: 'plain object message' }, 'plain object message'],
    [{ message: 17 }, 17],
    [{}, undefined],
    ['plain string', undefined],
    [42, undefined],
    [false, undefined],
  ] as const;
  for (const [failure, expected] of failures) {
    let reported: unknown;
    await act(async () => {
      await result.current.run(async () => { throw failure; }, { onError: value => { reported = value; } });
    });
    assert.equal(result.current.error, expected);
    assert.equal(reported, failure);
    assert.equal(result.current.busy, false);
  }
});

test('useAction preserves nullish property-access failures and skips later error callbacks', async () => {
  const { result } = renderHook(useAction);
  for (const failure of [null, undefined]) {
    let reported = false;
    await act(async () => {
      await assert.rejects(result.current.run(async () => { throw failure; }, { onError: () => { reported = true; } }), {
        name: 'TypeError', message: `Cannot read properties of ${failure} (reading 'message')`,
      });
    });
    assert.equal(result.current.error, '');
    assert.equal(result.current.busy, false);
    assert.equal(reported, false);
  }
});

test('useAction swallowed-error mode retains the previous error and releases busy state', async () => {
  const { result } = renderHook(useAction);
  act(() => result.current.setError('earlier start error'));
  await act(async () => {
    await result.current.run(async () => { throw null; }, { clearError: false, recordError: false });
  });
  assert.equal(result.current.error, 'earlier start error');
  assert.equal(result.current.busy, false);
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  let run: Promise<string | undefined> | undefined;
  act(() => { run = result.current.run(() => pending); });
  assert.equal(result.current.error, '');
  assert.equal(result.current.busy, true);
  await act(async () => { finish('completed'); await run; });
  assert.equal(await run, 'completed');
  assert.equal(result.current.busy, false);
});
