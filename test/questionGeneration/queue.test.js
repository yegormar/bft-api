'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createQueue } = require('../../src/services/questionGeneration/queue');

describe('questionGeneration/queue', () => {
  it('processes one at a time in FIFO order', async () => {
    const order = [];
    const processor = async (context) => {
      order.push(context.id);
      await new Promise((r) => setTimeout(r, 10));
      return { value: context.id };
    };
    const queue = createQueue(processor);
    const p1 = queue.enqueue({ id: 'a' });
    const p2 = queue.enqueue({ id: 'b' });
    const p3 = queue.enqueue({ id: 'c' });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
    assert.strictEqual(r1.value, 'a');
    assert.strictEqual(r2.value, 'b');
    assert.strictEqual(r3.value, 'c');
  });

  it('propagates processor rejection', async () => {
    const processor = async () => {
      throw new Error('processor error');
    };
    const queue = createQueue(processor);
    await assert.rejects(queue.enqueue({}), { message: 'processor error' });
  });

  it('resolves with null when processor returns null', async () => {
    const queue = createQueue(async () => null);
    const result = await queue.enqueue({ id: 'x' });
    assert.strictEqual(result, null);
  });
});
