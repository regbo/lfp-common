export {
  MESSAGE_KIND,
  PROTOCOL_VERSION,
  RPC_OPERATION,
  WEBSOCKET_SUBPROTOCOL,
  WIRE_VALUE_TYPE,
} from './_generated/protocol';
export type {
  MessageKind,
  RpcOperation,
  WireValueType,
} from './_generated/protocol';

import { WIRE_VALUE_TYPE } from './_generated/protocol';
import type { WireValueType } from './_generated/protocol';

export function isWireValueType(value: unknown): value is WireValueType {
  return typeof value === 'string' && Object.values(WIRE_VALUE_TYPE).includes(
    value as WireValueType,
  );
}
