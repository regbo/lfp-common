/** Reject when a promise does not settle within the supplied unref'ed timeout. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  purpose: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${purpose} timed out after ${timeoutMs} ms.`)),
      timeoutMs,
    );
    timer.unref();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
