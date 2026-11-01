const PYTHON_MODULE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u;

export function isPythonModuleName(value: string): boolean {
  return PYTHON_MODULE.test(value);
}

export function assertPythonPackageSpec(spec: string): void {
  if (!spec || spec.startsWith('-') || /[\0\r\n]/u.test(spec)) {
    throw new TypeError(`Unsafe Python package specifier: ${JSON.stringify(spec)}`);
  }
}
