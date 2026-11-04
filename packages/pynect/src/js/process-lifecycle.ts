import os from 'node:os';

export const FORWARD_SIGNAL = Symbol('pynect.forwardSignal');

export type TerminationSignal = 'SIGHUP' | 'SIGINT' | 'SIGQUIT' | 'SIGTERM' | 'SIGBREAK';

export interface ProcessLifecycleResource {
  close(): Promise<void>;
  forceClose(): void;
  [FORWARD_SIGNAL](signal: TerminationSignal): Promise<void>;
}

const terminationSignals: readonly TerminationSignal[] = process.platform === 'win32'
  ? ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGBREAK']
  : ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'];

const activeResources = new Set<ProcessLifecycleResource>();
let naturalExitCleanup: Promise<void> | undefined;
let signalCleanup: Promise<void> | undefined;
let exitHooksRegistered = false;

const signalHandlers = new Map<TerminationSignal, () => void>(
  terminationSignals.map(signal => [signal, () => { void handleTerminationSignal(signal); }]),
);

/** Keep the host alive while an active Pynect resource forwards termination and cleans up. */
export function trackProcessLifecycle(resource: ProcessLifecycleResource): void {
  activeResources.add(resource);
  registerExitHooks();
}

export function untrackProcessLifecycle(resource: ProcessLifecycleResource): void {
  activeResources.delete(resource);
  if (activeResources.size === 0) unregisterExitHooks();
}

function registerExitHooks(): void {
  if (exitHooksRegistered) return;
  exitHooksRegistered = true;
  process.on('beforeExit', handleBeforeExit);
  process.once('exit', handleExit);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
}

function unregisterExitHooks(): void {
  if (!exitHooksRegistered) return;
  exitHooksRegistered = false;
  process.off('beforeExit', handleBeforeExit);
  process.off('exit', handleExit);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}

function handleBeforeExit(): void {
  if (activeResources.size === 0 || naturalExitCleanup) return;
  naturalExitCleanup = closeActiveResources().finally(() => {
    naturalExitCleanup = undefined;
  });
}

function handleExit(): void {
  for (const resource of [...activeResources]) resource.forceClose();
}

function closeActiveResources(signal?: TerminationSignal): Promise<void> {
  const resources = [...activeResources];
  return Promise.allSettled(
    resources.map(resource => signal ? resource[FORWARD_SIGNAL](signal) : resource.close()),
  ).then(() => undefined);
}

function handleTerminationSignal(signal: TerminationSignal): Promise<void> {
  if (signalCleanup) return signalCleanup;
  signalCleanup = closeActiveResources(signal).finally(() => {
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });
  return signalCleanup;
}
