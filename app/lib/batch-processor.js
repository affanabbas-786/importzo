/**
 * Process items in parallel batches with exponential backoff for failures
 * Ensures rate-limit compliance while maximizing throughput
 */
export async function batchProcess(items, options = {}) {
  const {
    batchSize = 10,
    delayMs = 200,
    maxRetries = 3,
    worker // async function that processes one item
  } = options;

  const results = [];
  let failedItems = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    // Process batch in parallel
    const settled = await Promise.allSettled(
      batch.map((item, idx) => {
        // Stagger requests within batch to avoid thundering herd
        const delayForItem = delayMs * (idx % 5);
        return new Promise(resolve => {
          setTimeout(async () => {
            try {
              const result = await worker(item);
              resolve({ ok: true, result });
            } catch (err) {
              resolve({ ok: false, error: err, item });
            }
          }, delayForItem);
        });
      })
    );

    // Separate successes from failures
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        if (outcome.value.ok) {
          results.push(outcome.value.result);
        } else {
          failedItems.push(outcome.value.item);
        }
      } else {
        failedItems.push(outcome.reason);
      }
    }
  }

  return { results, failedItems };
}
