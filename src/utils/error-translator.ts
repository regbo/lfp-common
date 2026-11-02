/**
 * pynect - Error Translator
 * Converts Python exceptions into proper JavaScript Error subclasses.
 * Preserves full traceback, exception type, and chained causes.
 */

import type { PyErrorInfo } from '../types/python';

/**
 * Base class for all Python-originating errors.
 * Provides access to Python-specific error metadata.
 */
export class PythonError extends Error {
  /** Python exception class name (e.g. 'ValueError', 'FileNotFoundError') */
  readonly pythonType: string;
  /** Python module where the exception originated */
  readonly pythonModule: string;
  /** Full Python traceback string */
  readonly traceback: string;
  /** Original PyErrorInfo object */
  readonly pyErrorInfo: PyErrorInfo;

  constructor(info: PyErrorInfo) {
    super(`[Python ${info.type}] ${info.message}`);
    this.name = 'PythonError';
    this.pythonType = info.type;
    this.pythonModule = info.module ?? 'builtins';
    this.traceback = info.traceback;
    this.pyErrorInfo = info;

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, new.target.prototype);

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PythonError);
    }
  }

  /** Format error with Python traceback for display */
  format(): string {
    return [
      `PythonError: ${this.pythonType}: ${this.pyErrorInfo.message}`,
      '',
      '--- Python Traceback ---',
      this.traceback,
      '--- Node.js Stack ---',
      this.stack ?? '',
    ].join('\n');
  }
}

// Specific Python Exception Subclasses

export class PythonValueError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonValueError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonTypeError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonTypeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonKeyError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonKeyError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonIndexError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonIndexError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonAttributeError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonAttributeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonImportError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonImportError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonModuleNotFoundError extends PythonImportError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonModuleNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonFileNotFoundError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonFileNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonPermissionError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonPermissionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonRuntimeError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonRuntimeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonMemoryError extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonMemoryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonStopIteration extends PythonError {
  constructor(info: PyErrorInfo) {
    super(info);
    this.name = 'PythonStopIteration';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PythonTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, operation: string) {
    super(`Python operation timed out after ${timeoutMs}ms: ${operation}`);
    this.name = 'PythonTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PynectClosedError extends Error {
  constructor(message = 'The Pynect Python bridge is closed.') {
    super(message);
    this.name = 'PynectClosedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Error Translation Map

type PythonErrorConstructor = new (info: PyErrorInfo) => PythonError;

const EXCEPTION_MAP: Record<string, PythonErrorConstructor> = {
  ValueError: PythonValueError,
  TypeError: PythonTypeError,
  KeyError: PythonKeyError,
  IndexError: PythonIndexError,
  AttributeError: PythonAttributeError,
  ImportError: PythonImportError,
  ModuleNotFoundError: PythonModuleNotFoundError,
  FileNotFoundError: PythonFileNotFoundError,
  PermissionError: PythonPermissionError,
  RuntimeError: PythonRuntimeError,
  MemoryError: PythonMemoryError,
  StopIteration: PythonStopIteration,
  StopAsyncIteration: PythonStopIteration,
};

/**
 * Translates a PyErrorInfo (from the C++ addon) into the appropriate
 * JavaScript Error subclass. Falls back to generic PythonError.
 */
export function translatePythonError(info: PyErrorInfo): PythonError {
  const Ctor = EXCEPTION_MAP[info.type] ?? PythonError;
  return new Ctor(info);
}

/**
 * Type guard: checks whether a value is a PythonError.
 */
export function isPythonError(value: unknown): value is PythonError {
  return value instanceof PythonError;
}

/**
 * Type guard: checks whether a value is a specific Python exception type.
 */
export function isPythonErrorOfType(value: unknown, pythonType: string): value is PythonError {
  return value instanceof PythonError && value.pythonType === pythonType;
}
