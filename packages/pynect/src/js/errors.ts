export interface RemotePythonError {
  readonly message: string;
  readonly traceback?: string;
  readonly type: string;
}

export class PythonError extends Error {
  readonly pythonType: string;
  readonly pythonTraceback?: string;

  constructor(error: RemotePythonError) {
    super(error.message);
    this.name = 'PythonError';
    this.pythonType = error.type;
    this.pythonTraceback = error.traceback;
    if (error.traceback) this.stack = `${this.stack ?? this.message}\n\n${error.traceback}`;
  }
}

export class VenvClosedError extends Error {
  constructor(message = 'The Python Venv is closed.') {
    super(message);
    this.name = 'VenvClosedError';
  }
}

export class VenvStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VenvStartupError';
  }
}
