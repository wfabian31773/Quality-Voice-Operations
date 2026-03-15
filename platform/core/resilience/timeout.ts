/**
 * Race any promise against a deadline.
 * Throws a descriptive error on timeout; does NOT suppress the original promise.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  context?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${context ?? 'Operation'} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
