// RFC A.4 "To-do tools are executors": an order becomes a Todoist task, and the person completing it there is the outcome.

import { setTimeout as wait } from 'node:timers/promises';
import { Cancelled, type ExecCtx, type Outcome } from '@pbcp/client';
import type { OrderCard } from '@pbcp/core';
import type { NewTask, TodoistSource } from './source.js';

/** The first body line `due: <when>` (any case); `<when>` goes to Todoist as `due_string`, natural language included. */
const DUE = /^[ \t]*due:[ \t]*(\S.*?)[ \t]*$/im;
/** A.4 idempotency key: the order id, written into the task's description. */
export const marker = (orderId: string) => `pbcp: ${orderId}`;

export function taskFor(order: OrderCard): NewTask {
  const due = DUE.exec(order.body)?.[1];
  const body = order.body.replace(DUE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { content: order.title, description: [body, marker(order.id)].filter(Boolean).join('\n\n'), ...(due ? { due_string: due } : {}) };
}

export function todoistRun(src: TodoistSource, opts: { pollMs?: number; onError?: (e: unknown) => void } = {}) {
  return async (order: OrderCard, ctx: ExecCtx): Promise<Outcome> => {
    // A re-claim after a crash finds the task the earlier run created, instead of creating a second.
    let task = await src.find(marker(order.id));
    if (!task) {
      await ctx.checkpoint(); // A.5: renew before the irreversible step
      task = await src.create(taskFor(order));
      await ctx.progress(`Added to Todoist: ${task.content}`);
    }
    try {
      for (;;) {
        await ctx.checkpoint(); // the lease renewal, and the cancellation check
        // A Todoist error while waiting is retried at the next poll, not turned into a failed order.
        const now = await src.get(task.id).catch((e) => void (opts.onError ?? console.error)(e));
        if (now?.state === 'done') return { kind: 'signal', title: `Done: ${now.content}`, body: `Completed in Todoist${now.completedAt ? ` at ${now.completedAt}` : ''}.` };
        if (now?.state === 'deleted') return { kind: 'failed', title: `Not done: ${order.title}`, body: `The Todoist task "${task.content}" was deleted without being completed.` };
        await wait(opts.pollMs ?? 60_000, undefined, { signal: ctx.signal });
      }
    } catch (e) {
      const stop = e instanceof Cancelled ? e : ctx.signal.aborted ? ctx.signal.reason : e;
      if (!(stop instanceof Cancelled && stop.reason === 'cancelled')) throw stop; // shutdown or a lost lease: leave the task
      await src.delete(task.id); // A.5 roll back: the person cancelled, so the task goes rather than showing as completed
      return { kind: 'failed', title: `Stopped: ${order.title}`, body: `The order was cancelled, so the Todoist task "${task.content}" was deleted.` };
    }
  };
}
