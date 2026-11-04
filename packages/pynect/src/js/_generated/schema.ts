// Generated from pynect_worker.models. Do not edit directly.

import { z } from 'zod';
import type { ServerOptions, WorkerOptions } from './schema-types';

export type { ServerOptions, WorkerOptions } from './schema-types';

export const workerOptionsJsonSchema = {
  "additionalProperties": false,
  "description": "Behavior shared by local IPC workers and remote sessions.",
  "properties": {
    "validatePydantic": {
      "default": true,
      "description": "Validate annotated Python arguments with Pydantic.",
      "title": "Validate Pydantic",
      "type": "boolean"
    }
  },
  "title": "WorkerOptions",
  "type": "object"
} as const;
export const serverOptionsJsonSchema = {
  "additionalProperties": false,
  "description": "Loopback-first WebSocket server configuration.",
  "properties": {
    "host": {
      "default": "127.0.0.1",
      "description": "Interface on which the proxy-facing server listens.",
      "minLength": 1,
      "title": "Host",
      "type": "string"
    },
    "maxFrameBytes": {
      "default": 8388608,
      "description": "Maximum MessagePack payload size for one RPC frame.",
      "exclusiveMinimum": 0,
      "maximum": 4294967291,
      "title": "Max Frame Bytes",
      "type": "integer"
    },
    "modules": {
      "additionalProperties": {
        "type": "string"
      },
      "default": {},
      "description": "Public module names mapped to importable Python module names.",
      "title": "Modules",
      "type": "object"
    },
    "path": {
      "default": "/pynect",
      "description": "Absolute WebSocket URL path accepted by the server.",
      "title": "Path",
      "type": "string"
    },
    "port": {
      "default": 0,
      "description": "Listening port; zero asks the operating system to choose one.",
      "maximum": 65535,
      "minimum": 0,
      "title": "Port",
      "type": "integer"
    },
    "validatePydantic": {
      "default": true,
      "description": "Validate annotated Python arguments with Pydantic.",
      "title": "Validate Pydantic",
      "type": "boolean"
    }
  },
  "title": "ServerOptions",
  "type": "object"
} as const;

export const workerOptionsSchema = z.fromJSONSchema(workerOptionsJsonSchema) as z.ZodObject<{
  validatePydantic: z.ZodDefault<z.ZodBoolean>;
}>;
export const serverOptionsSchema = z.fromJSONSchema(
  serverOptionsJsonSchema,
) as z.ZodType<ServerOptions>;

// Assert the generated runtime schema remains assignable to the generated static type.
const _workerOptionsTypecheck: z.ZodType<WorkerOptions> = workerOptionsSchema;
void _workerOptionsTypecheck;
