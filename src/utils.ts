/** fetch 带超时（宿主 JSC 沙箱无 AbortController，用 Promise.race 实现）；超时后底层请求无法取消，但结果会被忽略 */
export function fetchWithTimeout(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
    fetch(url)
      .then(async (resp) => {
        const text = await resp.text();
        clearTimeout(timer);
        resolve({ status: resp.status, text });
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}
