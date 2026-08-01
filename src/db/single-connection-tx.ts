/**
 * One connection, one transaction at a time.
 *
 * A SQLite adapter holds a SINGLE connection, and a transaction on it is a
 * `BEGIN` … `COMMIT` pair issued as ordinary statements. Two pieces of work whose
 * turns interleave across an `await` therefore both issue `BEGIN` on that one
 * connection, and the second is refused outright: "cannot start a transaction
 * within a transaction".
 *
 * That refusal is not a caller mistake. Nothing about opening a workspace and
 * then changing its shape on the next line says the two share a connection, and
 * the failure names a nesting the caller never wrote. So the connection
 * SERIALIZES overlapping transactions rather than failing them: the second one
 * waits for the first to commit and then runs unchanged. The queue is per
 * connection, which is exactly the resource being contended for.
 *
 * A caller that is ALREADY inside a transaction is a different situation and is
 * refused LOUDLY rather than queued. Queueing it would wait for a transaction
 * that cannot commit until the waiter returns — a deadlock, and a hang is a worse
 * answer than an error. Such a caller was handed a transaction client and must
 * use that, so the error says so.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Serializes transactions on one connection.
 *
 * `run` queues `fn` behind any transaction already in flight and resolves with
 * its result. A rejected `fn` never poisons the queue — the chain advances on
 * settle either way — and the caller still sees the rejection.
 */
export class SingleConnectionTransactions {
  private readonly _inside = new AsyncLocalStorage<true>();
  private _chain: Promise<unknown> = Promise.resolve();

  /** Run `fn` with the connection's transaction to itself. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this._inside.getStore()) {
      return Promise.reject(
        new Error(
          'cannot start a transaction within a transaction: this connection is already inside ' +
            'one, so waiting for it would never return — use the transaction client you were given',
        ),
      );
    }
    const started = this._chain.then(() => this._inside.run(true, fn));
    this._chain = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }
}
