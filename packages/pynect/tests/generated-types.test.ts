import { describe, expect, test } from 'bun:test';
import { createVenv } from '../src';

interface GeneratedMathModule {
  sqrt(value: number): Promise<number>;
}

interface GeneratedModules {
  standardMath: GeneratedMathModule;
}

describe('generated module seam', () => {
  test('accepts a generated type map without starting Python', async () => {
    const venv = createVenv<GeneratedModules>({
      modules: { standardMath: 'math' },
      project: false,
    });
    const typedImport: () => Promise<GeneratedMathModule> = () => venv.import('standardMath');

    expect(typeof typedImport).toBe('function');
    expect(venv.started).toBe(false);
    await venv.close();
  });
});
