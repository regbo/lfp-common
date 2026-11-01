/**
 * pynect - Logger
 * Structured logger with level filtering and colorized output.
 */

import type { LogLevel } from '../types/config';

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
};

function colorize(color: keyof typeof COLORS, text: string): string {
  if (!process.stdout.isTTY) {return text;}
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function formatTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

export class Logger {
  private _level: LogLevel;
  private _prefix: string;
  private static _globalLevel: LogLevel = 'warn';

  constructor(prefix: string, level?: LogLevel) {
    this._prefix = prefix;
    this._level = level ?? Logger._globalLevel;
  }

  static setGlobalLevel(level: LogLevel): void {
    Logger._globalLevel = level;
  }

  setLevel(level: LogLevel): void {
    this._level = level;
  }

  private _shouldLog(level: LogLevel): boolean {
    return LEVELS[level] <= LEVELS[this._level];
  }

  private _format(level: string, message: string, data?: unknown): string {
    const ts = colorize('gray', formatTimestamp());
    const lvl = level;
    const prefix = colorize('blue', `[${this._prefix}]`);
    let line = `${ts} ${lvl} ${prefix} ${message}`;
    if (data !== undefined) {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      line += `\n${colorize('gray', dataStr)}`;
    }
    return line;
  }

  error(message: string, data?: unknown): void {
    if (!this._shouldLog('error')) {return;}
    const lvl = colorize('red', 'ERROR');
    console.error(this._format(lvl, message, data));
  }

  warn(message: string, data?: unknown): void {
    if (!this._shouldLog('warn')) {return;}
    const lvl = colorize('yellow', 'WARN ');
    console.warn(this._format(lvl, message, data));
  }

  info(message: string, data?: unknown): void {
    if (!this._shouldLog('info')) {return;}
    const lvl = colorize('cyan', 'INFO ');
    console.info(this._format(lvl, message, data));
  }

  debug(message: string, data?: unknown): void {
    if (!this._shouldLog('debug')) {return;}
    const lvl = colorize('gray', 'DEBUG');
    console.debug(this._format(lvl, message, data));
  }

  success(message: string, data?: unknown): void {
    if (!this._shouldLog('info')) {return;}
    const lvl = colorize('green', 'OK   ');
    console.info(this._format(lvl, message, data));
  }

  time(label: string): () => void {
    const start = performance.now();
    return () => {
      const elapsed = (performance.now() - start).toFixed(2);
      this.debug(`${label} completed in ${elapsed}ms`);
    };
  }

  child(subPrefix: string): Logger {
    return new Logger(`${this._prefix}:${subPrefix}`, this._level);
  }
}

/** Global logger factory */
export function createLogger(prefix: string, level?: LogLevel): Logger {
  return new Logger(prefix, level);
}

/** Default Pynect logger */
export const logger = createLogger('pynect');
