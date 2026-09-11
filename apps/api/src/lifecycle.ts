/**
 * Whether this process has started shutting down.
 *
 * It is process state rather than something threaded through the application because the one place
 * that has to know is `/health`, and a load balancer asking it is the only way a draining instance
 * stops being sent new requests. Closing the listener is not enough on its own: connections that are
 * already open keep serving until they go idle, which is exactly what makes the shutdown graceful.
 */

let draining = false;

/** Called once, by the shutdown sequence, before anything is closed. */
export function beginDraining() { draining = true; }
export function isDraining() { return draining; }
/** Test-only: restores the initial state so one suite does not leave the next one draining. */
export function resetDraining() { draining = false; }
