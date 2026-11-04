import { describe, expect, test } from 'bun:test';
import { createVenv } from '../src/js';

interface MathModule {
  sqrt(value: number): Promise<number>;
}

interface Modules {
  standardMath: MathModule;
}

describe('typed module seam', () => {
  test('accepts an application-defined module map without starting Python', async () => {
    const venv = createVenv<Modules>({
      modules: { standardMath: 'math' },
      project: false,
    });
    const typedImport: () => Promise<MathModule> = () => venv.import('standardMath');

    expect(typeof typedImport).toBe('function');
    expect(venv.started).toBe(false);
    await venv.close();
  });
});
