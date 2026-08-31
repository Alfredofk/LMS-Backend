import rateLimit from 'express-rate-limit';

/*
  Rate limiting is one of the four things that make the School Code model
  defensible (ADR-0002). It does not stand alone - the human approval gate is
  the real control - but it raises the cost of guessing codes or bulk-creating
  accounts enough that the gate is never facing a flood.

  Every limiter here is keyed on the most specific identity available, NOT on
  req.ip - which is what express-rate-limit keys on by default. In Indonesia one
  public IP is one computer lab, one school Wi-Fi, or one carrier CGNAT block,
  so "per IP" reads as "per school" and an IP-keyed limit punishes a class of
  forty for the behaviour of one. Keyed per person, a lab of forty and a
  hundred students joining at once are simply forty and a hundred separate
  budgets.

  The other half of the rule: what burns budget is the attempt that FAILED.
  Typing your own school code correctly should cost nothing.
*/

/*
  A single IPv6 customer holds an entire /64, so keying on the full address lets
  an attacker rotate through 18 quintillion buckets. Truncating to the /64 makes
  the subnet the unit, which is what the ISP actually hands out.

  express-rate-limit ships an ipKeyGenerator helper for this in later releases;
  7.5.1 does not export one, so it lives here.
*/
function expandV6(address) {
    const bare = address.split('%')[0]; // drop the zone id on fe80::1%eth0
    const [head, tail] = bare.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = bare.includes('::')
        ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
        : left;

    return groups.map((group) => (group || '0').replace(/^0+(?=.)/, '').toLowerCase());
}

function ipKey(req) {
    const address = req.ip;
    if (!address) return 'unknown-ip';

    // ::ffff:203.0.113.5 is an IPv4 address wearing an IPv6 coat.
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return mapped[1];
    if (!address.includes(':')) return address;

    return `${expandV6(address).slice(0, 4).join(':')}::/64`;
}

// Limit the person when we know who they are; only fall back to the network.
const byUserThenIp = (req) => req.auth?.userId ?? ipKey(req);

/*
  Brute force attacks ONE account, so the bucket belongs to that account.

  Keyed on the IP alone, five students fumbling their password would lock their
  whole class out for fifteen minutes - and a 429 is returned before the handler
  runs, so a correct password would not rescue them.

  The email comes from req.body, which means this limiter only works mounted
  after express.json(), and the value has to be normalised and bounded before it
  becomes a store key.
*/
const byIpAndEmail = (req) => {
    const raw = req.body?.email;
    const email = typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 254) : null;
    const ip = ipKey(req);

    return email ? `${ip}:${email}` : ip;
};

const envelope = (message) => ({
    success: false,
    data: null,
    error: { code: 'TOO_MANY_REQUESTS', message },
});

const build = ({ windowMs, limit, message, keyGenerator, skipSuccessfulRequests = false }) =>
    rateLimit({
        windowMs,
        limit,
        keyGenerator,
        skipSuccessfulRequests,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: envelope(message),
    });

// Password guessing, per account. A wrong password costs; a right one does not.
const loginLimiter = build({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    keyGenerator: byIpAndEmail,
    skipSuccessfulRequests: true,
    message: 'Too many failed login attempts for this account. Try again in a few minutes.',
});

/*
  School Code lookup and the join request that follows - one flow, one limiter.

  Both happen after login, so both key on the user, and separating "lookup" from
  "join" would only be separating two halves of the same act. Deliberately
  loose: the real ceiling is in the database, where a partial unique index
  allows one PENDING or ACTIVE membership per user and
  assertMembershipRetryAllowed() caps rejected retries. This only damps HTTP
  spam, so only failed guesses count.
*/
const joinSchoolLimiter = build({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    keyGenerator: byUserThenIp,
    skipSuccessfulRequests: true,
    message: 'Too many incorrect school codes. Try again later.',
});

/*
  School registration: a human reviews each one, so the ceiling is low.

  Per applicant, not per address - ten schools registering from one Dinas
  onboarding event are ten applicants with ten budgets. The durable version of
  this rule is assertSchoolRegistrationAllowed() in ./approval.js; this is only
  the traffic shield in front of it, because the memory store forgets on every
  restart.
*/
const registrationLimiter = build({
    windowMs: 24 * 60 * 60 * 1000,
    limit: 5,
    keyGenerator: byUserThenIp,
    message: 'Too many school registration submissions today. Try again tomorrow.',
});

/*
  Two ceilings, one limiter.

  A signed-in user will never approach 1000 requests in fifteen minutes through
  normal use. Anonymous traffic is a different animal: only /auth/* and the code
  lookup reach here unauthenticated, and this is the only thing standing in
  front of account creation - the bulk-account threat named above. Forty
  students signing in one morning is well under a hundred anonymous requests.
*/
const generalLimiter = build({
    windowMs: 15 * 60 * 1000,
    limit: (req) => (req.auth?.userId ? 1000 : 300),
    keyGenerator: byUserThenIp,
    message: 'Too many requests.',
});

export {
    loginLimiter,
    joinSchoolLimiter,
    registrationLimiter,
    generalLimiter,
};
