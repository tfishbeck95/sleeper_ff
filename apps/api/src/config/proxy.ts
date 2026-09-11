/**
 * How many hops of `X-Forwarded-For` this process believes, and why the answer is never a guess.
 *
 * `req.ip` is the only thing the per-address rate limits can be charged to, and behind a proxy it is
 * whatever this setting says it is. Both ways of getting it wrong are silent:
 *
 * - **Too low** — every request appears to come from the proxy, so one bucket is shared by every
 *   client on the internet. The first person to exhaust it locks out everybody else, and the limits
 *   look like they are working right up until they are the outage.
 * - **Too high** — Express walks further up the forwarded chain than there are real proxies, so it
 *   reads a value the *client* put there. A caller then picks their own address, a fresh one per
 *   request, and the rate limits stop existing. `TRUST_PROXY=true` is this case unconditionally: it
 *   means "believe the whole chain", and the left-hand end of that chain is always the client.
 *
 * The deployment this is configured for is the one in docs/deployment.md: a load balancer terminating
 * TLS in front of a fleet of API instances, with the dashboard's static server or a CDN beside it —
 * exactly one hop that rewrites the client address, which is why `deploy/compose.yaml` sets
 * `TRUST_PROXY: "1"` and why a hop count is the form an operator should be reaching for.
 *
 * A production process that serves application traffic therefore has to say which shape it is, and
 * cannot say "believe everything":
 *
 * - a **count** — the number of proxies, the normal answer;
 * - a **list** of the proxies' own addresses or subnets, or `loopback`/`linklocal`/`uniquelocal`,
 *   for a deployment where the count varies but the addresses do not;
 * - the exact string **`false`**, which is the API exposed directly with nothing in front of it,
 *   stated rather than arrived at by leaving a variable unset.
 *
 * The worker is exempt, because the setting does nothing there: it binds no application port, and
 * its liveness probe does not look at a client address. Demanding a value from a process that cannot
 * use one is how a required setting becomes a value people paste in without reading.
 *
 * Outside production anything is allowed, including unset, because a developer's machine has no
 * proxy and no attacker.
 */

export type TrustProxySetting = boolean | number | string;

export class TrustProxyError extends Error {
  constructor(message: string) { super(message); this.name = 'TrustProxyError'; }
}

const NAMED = ['loopback', 'linklocal', 'uniquelocal'];
const ADDRESS_OR_SUBNET = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

const FORMS = `'false' for an API exposed directly, the number of proxies in front of this process, or a comma-separated list of their addresses, subnets or the names ${NAMED.join('/')}`;

export interface TrustProxyContext {
  production: boolean;
  /**
   * Whether this process serves application traffic, and therefore has client addresses to charge
   * rate limits to. False for the worker, which binds no application port.
   */
  servesHttp?: boolean;
}

/**
 * Parses `TRUST_PROXY`, refusing what Express would otherwise accept and misinterpret.
 *
 * A word Express does not recognize throws inside `app.set('trust proxy', …)`, which happens after
 * the startup log line that would have explained it — so it is checked here, where the message can
 * name the variable and list the forms.
 */
export function parseTrustProxy(value: string | undefined, { production, servesHttp = true }: TrustProxyContext): TrustProxySetting {
  const enforced = production && servesHttp;
  const raw = value?.trim();
  if (raw === undefined || raw === '') {
    if (enforced) {
      throw new TrustProxyError(`Refusing to start: TRUST_PROXY is not set. Behind a proxy an unset value charges every client's requests to one shared rate-limit bucket; exposed directly it is correct, but it has to be stated. Set ${FORMS}.`);
    }
    return false;
  }
  if (raw === 'false') return false;
  if (raw === 'true') {
    // The one value that is never right for a process serving traffic: it trusts the entire
    // forwarded chain, whose left-hand end is written by the client, which lets a caller choose the
    // address their rate limit is charged to.
    if (enforced) throw new TrustProxyError(`Refusing to start: TRUST_PROXY=true trusts the whole X-Forwarded-For chain, including the part the client wrote, so a caller can choose the address their rate limits are charged to. Set ${FORMS}.`);
    return true;
  }
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops > 16) throw new TrustProxyError(`Refusing to start: TRUST_PROXY=${hops} claims more proxies than any deployment of this application has. Set ${FORMS}.`);
    return hops;
  }
  const entries = raw.split(',').map(entry => entry.trim()).filter(Boolean);
  if (entries.length && entries.every(entry => NAMED.includes(entry) || ADDRESS_OR_SUBNET.test(entry))) return raw;
  throw new TrustProxyError(`Refusing to start: TRUST_PROXY must be ${FORMS} — not '${raw}'.`);
}

/** The setting for this process, for the composition roots that build an application directly. */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): TrustProxySetting {
  return parseTrustProxy(env.TRUST_PROXY, { production: env.NODE_ENV === 'production' });
}

/** One word for the startup log: what the deployment says is in front of this process. */
export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) return 'direct';
  if (setting === true) return 'all-hops';
  return typeof setting === 'number' ? `${setting}-hop` : 'listed';
}
