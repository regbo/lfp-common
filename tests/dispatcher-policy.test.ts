import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const python = path.join(
  root,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);

describe('typed dispatcher policy', () => {
  const run = fs.existsSync(python) ? test : test.skip;

  run('requires type hints independently from the export marker', () => {
    const source = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(root, 'python'))})
import pynect_dispatcher as dispatcher

def typed(value: int) -> int:
    return value

@dispatcher.export
def exported_but_untyped(value):
    return value

typed.__module__ = "example"
exported_but_untyped.__module__ = "example"
dispatcher.configure({"typedOnly": True})
assert dispatcher.invoke(typed, [7], {}) == 7
try:
    dispatcher.invoke(exported_but_untyped, [7], {})
except dispatcher.DispatchPermissionError:
    pass
else:
    raise AssertionError("@export must not bypass typedOnly")
`;
    const result = spawnSync(python, ['-c', source], { encoding: 'utf8' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
