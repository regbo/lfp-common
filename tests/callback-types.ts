import type { PynectCallback, PynectCallbackContext } from '../src';

declare const context: PynectCallbackContext;

const synchronous = context.callback((value: number) => value * 2);
const asynchronous = context.callback(async (value: number) => value * 2);
const synchronousType: PynectCallback<[number], number> = synchronous;
const asynchronousType: PynectCallback<[number], number> = asynchronous;

// @ts-expect-error Raw functions do not carry Pynect's private registration brand.
const unregistered: PynectCallback<[number], number> = (value: number) => value;

void synchronousType;
void asynchronousType;
void unregistered;
