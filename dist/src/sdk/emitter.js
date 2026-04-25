/**
 * Event emitter with async-iterator contract — Wish B Group 1 skeleton.
 *
 * The SDK's async iterator yields `AgentEvent`s as the agent runs. The
 * emitter is a thin broker: producers call `emit()` at state boundaries;
 * consumers iterate via `for await`. Multiple consumers may subscribe
 * to the same emitter — each receives every event.
 *
 * This file ships the contract shape only. Hooking the emitter into
 * `rlm.ts` + exposing `runAgent()` lands in Group 2-3 per WISH.md.
 */
/**
 * Create an emitter with an async-iterator backplane. Broadcasts to
 * every subscriber; each subscriber sees events in emit order. Buffers
 * events that arrive before any subscriber is attached so no early
 * emissions are lost.
 *
 * The buffer is unbounded by default — for Group 1 the expected
 * volume is ~10³ events per run. If back-pressure becomes an issue we
 * revisit (Group 3 per-depth metrics may push volume higher).
 */
export function createEmitter() {
    const subscribers = [];
    let closed = false;
    /** Shared pre-subscribe backlog — forwarded to the first subscriber. */
    const preBuffer = [];
    function flushTo(sub, events) {
        for (const ev of events) {
            const pull = sub.pending.shift();
            if (pull)
                pull.resolve({ value: ev, done: false });
            else
                sub.buffer.push(ev);
        }
    }
    function completeSub(sub) {
        if (sub.done)
            return;
        sub.done = true;
        while (sub.pending.length > 0) {
            const pull = sub.pending.shift();
            pull?.resolve({ value: undefined, done: true });
        }
    }
    function emit(event) {
        if (closed)
            return; // Silently drop post-close emissions.
        if (subscribers.length === 0) {
            preBuffer.push(event);
            return;
        }
        for (const sub of subscribers) {
            if (!sub.done)
                flushTo(sub, [event]);
        }
    }
    function close() {
        if (closed)
            return;
        closed = true;
        for (const sub of subscribers)
            completeSub(sub);
    }
    function subscribe() {
        const sub = {
            pending: [],
            buffer: [],
            done: false,
        };
        subscribers.push(sub);
        // Deliver any pre-subscribe backlog so late subscribers still
        // receive the run's opening events. Only the FIRST subscriber
        // drains the preBuffer to avoid re-broadcasting.
        if (subscribers.length === 1 && preBuffer.length > 0) {
            flushTo(sub, preBuffer);
            preBuffer.length = 0;
        }
        if (closed)
            completeSub(sub);
        const iter = {
            next() {
                if (sub.buffer.length > 0) {
                    const value = sub.buffer.shift();
                    return Promise.resolve({ value, done: false });
                }
                if (sub.done) {
                    return Promise.resolve({
                        value: undefined,
                        done: true,
                    });
                }
                return new Promise((resolve) => {
                    sub.pending.push({ resolve });
                });
            },
            return() {
                completeSub(sub);
                return Promise.resolve({ value: undefined, done: true });
            },
            throw(err) {
                completeSub(sub);
                return Promise.reject(err);
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
        return iter;
    }
    return {
        emit,
        close,
        get closed() {
            return closed;
        },
        subscribe,
        [Symbol.asyncIterator]() {
            return subscribe();
        },
    };
}
//# sourceMappingURL=emitter.js.map