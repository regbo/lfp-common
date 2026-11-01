import { describe, expect, test } from 'bun:test';
import { withPynectLock } from '../src/utils/locking';

describe('loqkit integration', () => {
  test('serializes actions sharing a Pynect lock key', async () => {
    let active = 0;
    let peak = 0;

    const results = await Promise.all(Array.from({ length: 4 }, async (_, index) =>
      withPynectLock(
        { index },
        async ({ index: lockedIndex }) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          return lockedIndex;
        },
        undefined,
        { key: 'test:shared', name: 'shared test lock' },
      ),
    ));

    expect(peak).toBe(1);
    expect(results.every(result => result.context.state === 'executed')).toBe(true);
    expect(results.map(result => result.value)).toEqual([0, 1, 2, 3]);
    const scope = results[0]?.context.lock.scope;
    expect(scope?.memory).toBe(true);
    expect(scope?.worker === true || scope?.worker === 'skipped').toBe(true);
    expect(scope?.flock === true || scope?.poll === true).toBe(true);
  });
});
