import {
  createPythonBridge,
  type PythonBridge,
  type PynectCallback,
} from '../src';

declare module '../src' {
  interface PynectModules {
    typed_fixture: { answer: number };
  }
}

const synchronous: PynectCallback<[number], number> = value => value * 2;
const asynchronous: PynectCallback<[number], number> = async value => value * 2;

void synchronous;
void asynchronous;

const createBridge: (config?: Parameters<typeof createPythonBridge>[0]) => Promise<PythonBridge> =
  createPythonBridge;

async function useBridge(bridge: PythonBridge): Promise<void> {
  const fixture = await bridge.import('typed_fixture');
  const answer: number = fixture.answer;
  void answer;
  await bridge.close();
}

void createBridge;
void useBridge;
