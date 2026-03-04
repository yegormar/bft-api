/**
 * FIFO queue with a single worker. Enqueued items are processed one at a time.
 * @param {(context: object) => Promise<object | null>} processor - async function that processes one context and returns result or null
 * @returns {{ enqueue(context: object): Promise<object | null> }}
 */
function createQueue(processor) {
  const pending = [];
  let processing = false;

  function drain() {
    if (processing || pending.length === 0) return;
    const { context, resolve, reject } = pending.shift();
    processing = true;
    processor(context)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        processing = false;
        drain();
      });
  }

  function enqueue(context) {
    return new Promise((resolve, reject) => {
      pending.push({ context, resolve, reject });
      drain();
    });
  }

  return { enqueue };
}

module.exports = { createQueue };
