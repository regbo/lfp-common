import { describe, expect, test } from 'bun:test';
import { withLock } from '../src/utils/lock';

describe('withLock', () => {
  test('checks before and after waiting and skips stale work', async () => {
    const context = { open: true };
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const actions: string[] = [];

    const first = withLock(
      context,
      current => current.open,
      async current => {
        actions.push('first');
        await firstMayFinish;
        current.open = false;
      },
    );
    await Promise.resolve();

    const second = withLock(
      context,
      current => current.open,
      () => {
        actions.push('second');
      },
    );

    releaseFirst();
    await Promise.all([first, second]);

    expect(actions).toEqual(['first']);
  });

  test('allows different contexts to run concurrently', async () => {
    const first = {};
    const second = {};
    const running: string[] = [];

    await Promise.all([
      withLock(first, () => true, async () => {
        running.push('first');
        await Promise.resolve();
        expect(running).toContain('second');
      }),
      withLock(second, () => true, () => {
        running.push('second');
      }),
    ]);
  });
});
