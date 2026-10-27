// RFC A.4 "To-do tools are executors": an order becomes a Todoist task, and the person completing it there is the outcome.

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

/** `TODOIST_TZ`: an IANA zone, checked at startup (a RangeError names a bad one); unset means UTC. */
export const zoneOf = (name?: string) => (name ? new Intl.DateTimeFormat('en-GB', { timeZone: name }).resolvedOptions().timeZone : undefined);

/** A local time a person reads at a glance: `today 09:12` on `now`'s day, else `Mon 26 Oct 16:00`. With no `zone`, UTC and
 *  named (`today 08:12 UTC`). An unparseable time is given as it came. */
export function readable(iso: string, now: Date, zone?: string): string {
  const [d, timeZone] = [new Date(iso), zone ?? 'UTC'];
  if (Number.isNaN(+d)) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  const day = (x: Date) => x.toLocaleDateString('en-CA', { timeZone });
  return `${day(d) === day(now) ? 'today' : `${p.weekday} ${p.day} ${p.month}`} ${p.hour}:${p.minute}${zone ? '' : ' UTC'}`;
}

export function todoistRun(src: TodoistSource, opts: { pollMs?: number; onError?: (e: unknown) => void; now?: () => Date; timeZone?: string } = {}) {
  return async (order: OrderCard, ctx: ExecCtx): Promise<Outcome> => {
    // A.4: a re-claim finds the earlier run's task in ctx.state, completed or not; failing that, by its marker while open.
    const known = await ctx.state.get<{ task: string }>();
    let task = known ? await src.get(known.task) : await src.find(marker(order.id));
    if (!task) {
      await ctx.checkpoint(); // A.5: renew before the irreversible step
      task = await src.create(taskFor(order));
      await ctx.state.set({ task: task.id });
      await ctx.progress(`Added to Todoist: ${task.content}`);
    } else if (!known) await ctx.state.set({ task: task.id });
    try {
      for (;;) {
        await ctx.checkpoint(); // the lease renewal, and the cancellation check
        // A Todoist error while waiting is retried at the next poll, not turned into a failed order.
        const now = await src.get(task.id).catch((e) => void (opts.onError ?? console.error)(e));
        if (now?.state === 'done') return { kind: 'signal', title: `Done: ${now.content}`, body: `Completed in Todoist${now.completedAt ? `, ${readable(now.completedAt, opts.now?.() ?? new Date(), opts.timeZone)}` : ''}.` };
        if (now?.state === 'deleted') return { kind: 'failed', title: `Not done: ${order.title}`, body: `The Todoist task "${task.content}" was deleted without being completed.` };
        await ctx.sleep(opts.pollMs ?? 60_000);
      }
    } catch (e) {
      if (!(e instanceof Cancelled && e.reason === 'cancelled')) throw e; // shutdown or a lost lease: leave the task
      await src.delete(task.id); // A.5 roll back: the person cancelled, so the task goes rather than showing as completed
      return { kind: 'failed', title: `Stopped: ${order.title}`, body: `The order was cancelled, so the Todoist task "${task.content}" was deleted.` };
    }
  };
}
