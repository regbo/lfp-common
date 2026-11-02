import type { PynectCallback } from '../src';

const synchronous: PynectCallback<[number], number> = value => value * 2;
const asynchronous: PynectCallback<[number], number> = async value => value * 2;

void synchronous;
void asynchronous;
