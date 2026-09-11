import { storageFailures, storageQueryDuration } from './instruments.js';

/**
 * Times every repository call, without any repository knowing it is being timed.
 *
 * A proxy rather than a wrapper class with sixty forwarding methods, and rather than a timer added
 * to each implementation. The repository interface is large and still growing; a hand-written
 * decorator would be out of date by the next method added, and one added inside `JsonStore` would
 * have to be added again inside the PostgreSQL adapter when it lands — which is precisely when the
 * numbers start to matter.
 *
 * The operation label is the *method name*, which is a closed set fixed by the interface. Arguments
 * are never read: they carry league ids and session digests, and a label built from one of those is
 * the unbounded-cardinality mistake this codebase keeps refusing.
 *
 * Failures are counted here rather than only logged because they are the signal that separates
 * "storage is answering but slowly" from "storage is failing under load while still passing a
 * readiness probe", which is the shape a dying disk or an exhausted connection pool takes.
 */
export function measured<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const operation = property;
      return function measuredCall(this: unknown, ...args: unknown[]) {
        const started = process.hrtime.bigint();
        const elapsed = () => Number(process.hrtime.bigint() - started) / 1e9;
        let result: unknown;
        try {
          result = (value as (...rest: unknown[]) => unknown).apply(this === receiver ? target : this, args);
        } catch (error) {
          // A synchronous throw, which a repository is allowed to do for a programming error.
          storageQueryDuration.observe({ operation }, elapsed());
          storageFailures.inc({ operation });
          throw error;
        }
        if (!(result instanceof Promise)) { storageQueryDuration.observe({ operation }, elapsed()); return result; }
        return result.then(
          resolved => { storageQueryDuration.observe({ operation }, elapsed()); return resolved; },
          error => { storageQueryDuration.observe({ operation }, elapsed()); storageFailures.inc({ operation }); throw error; },
        );
      };
    },
  });
}
