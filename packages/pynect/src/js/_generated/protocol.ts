// Generated from pynect_worker.models. Do not edit directly.

export const PROTOCOL_VERSION = 2 as const;
export const WEBSOCKET_SUBPROTOCOL = "pynect.v2" as const;

export const MESSAGE_KIND = {
  "callback": "callback",
  "callbackRelease": "callback_release",
  "callbackResult": "callback_result",
  "hello": "hello",
  "notify": "notify",
  "request": "request",
  "response": "response"
} as const;
export type MessageKind = typeof MESSAGE_KIND[keyof typeof MESSAGE_KIND];

export const RPC_OPERATION = {
  "call": "call",
  "dir": "dir",
  "get": "get",
  "import": "import",
  "iter": "iter",
  "next": "next",
  "release": "release",
  "repr": "repr",
  "set": "set",
  "shutdown": "shutdown",
  "value": "value"
} as const;
export type RpcOperation = typeof RPC_OPERATION[keyof typeof RPC_OPERATION];

export const WIRE_VALUE_TYPE = {
  "callback": "callback",
  "date": "date",
  "datetime": "datetime",
  "map": "map",
  "reference": "reference",
  "set": "set",
  "time": "time",
  "undefined": "undefined"
} as const;
export type WireValueType = typeof WIRE_VALUE_TYPE[keyof typeof WIRE_VALUE_TYPE];
