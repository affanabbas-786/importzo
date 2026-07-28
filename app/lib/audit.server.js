// ═══════════════════════════════════════════════════════════════════
// Phase 3.7 — Audit trail: who triggered what, when, from which IP.
//
// Two things make this less trivial than it looks:
//
// 1. THE WORKER HAS NO REQUEST. runMigrationWorker is fire-and-forget and
//    outlives the HTTP request that started it. By the time it writes log
//    entries there is no request, no session and no IP. So the actor is
//    captured at TRIGGER time onto MigrationJob, and the worker reads it
//    back and stamps it onto every entry it writes. An audit trail built
//    only at write time would attribute everything to nobody.
//
// 2. X-Forwarded-For IS CLIENT-CONTROLLABLE. Anyone can send that header.
//    It's only meaningful because a trusted reverse proxy (this app runs
//    under PM2 behind a TLS-terminating proxy) overwrites/appends it. We
//    take the LEFT-most entry, which is the closest thing to the origin
//    client, but a determined client can prepend a forged value. Treated
//    as best-effort evidence, never as an authorization input — nothing in
//    this app makes a security decision based on actorIp.
// ═══════════════════════════════════════════════════════════════════

export const ACTOR_TYPE = Object.freeze({
  USER: "user",         // a human in the Shopify admin
  SCHEDULE: "schedule", // a recurring sync firing on its own
  SYSTEM: "system",     // internal/automated, no human and no schedule
  UNKNOWN: "unknown",
});

// Longest-to-shortest so the most specific/trusted header wins.
const IP_HEADERS = [
  "x-forwarded-for",      // standard proxy chain
  "cf-connecting-ip",     // Cloudflare
  "x-real-ip",            // common nginx convention
  "true-client-ip",       // Akamai / Cloudflare Enterprise
];

const MAX_IP_LENGTH = 45; // an IPv6 address with an IPv4 suffix

function headerGet(request, name) {
  try {
    return request?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort client IP.
 *
 * Returns null rather than a placeholder when nothing usable is present —
 * an audit row that honestly says "unknown" is worth more than one asserting
 * a fabricated address.
 */
export function extractClientIp(request) {
  for (const header of IP_HEADERS) {
    const raw = headerGet(request, header);
    if (!raw) continue;

    // X-Forwarded-For is "client, proxy1, proxy2" — left-most is the origin.
    const first = String(raw).split(",")[0].trim();
    if (!first) continue;

    // Strip an IPv6 bracket/port form like [::1]:1234, and a bare :port.
    const cleaned = first
      .replace(/^\[(.+)\](?::\d+)?$/, "$1")
      .replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, "$1");

    if (cleaned.length > MAX_IP_LENGTH) continue; // junk / oversized header
    return cleaned;
  }
  return null;
}

/**
 * Builds the actor record for a request made by a human in the admin.
 *
 * Note on identity: this app uses OFFLINE Shopify sessions, which are keyed
 * to the shop rather than a staff user, so userId/email are frequently null.
 * When that's the case the actor is still recorded as a `user` (a human did
 * trigger it) with the shop as the only available identity, rather than being
 * silently downgraded to "system" — that would misattribute a human action.
 */
export function actorFromSession(request, session, { actorType = ACTOR_TYPE.USER } = {}) {
  const id = session?.userId != null ? String(session.userId) : null;
  const email = session?.email || null;

  return {
    actorType,
    actorId: id,
    actorEmail: email,
    actorIp: extractClientIp(request),
  };
}

/** A recurring sync firing on its own — no human, no request, no IP. */
export function actorForSchedule(scheduleId) {
  return {
    actorType: ACTOR_TYPE.SCHEDULE,
    actorId: scheduleId ? String(scheduleId) : null,
    actorEmail: null,
    actorIp: null,
  };
}

export function actorForSystem(reason = null) {
  return {
    actorType: ACTOR_TYPE.SYSTEM,
    actorId: reason,
    actorEmail: null,
    actorIp: null,
  };
}

/** Reads an actor back off a persisted record (e.g. MigrationJob). */
export function actorFromRecord(record) {
  if (!record) return { actorType: ACTOR_TYPE.UNKNOWN, actorId: null, actorEmail: null, actorIp: null };
  return {
    actorType: record.actorType || ACTOR_TYPE.UNKNOWN,
    actorId: record.actorId ?? null,
    actorEmail: record.actorEmail ?? null,
    actorIp: record.actorIp ?? null,
  };
}

/**
 * Human-readable attribution for logs and UI.
 * Never invents detail it doesn't have.
 */
export function describeActor(actor) {
  if (!actor || actor.actorType === ACTOR_TYPE.UNKNOWN) return "unknown actor";
  if (actor.actorType === ACTOR_TYPE.SCHEDULE) {
    return `scheduled sync${actor.actorId ? ` (${actor.actorId})` : ""}`;
  }
  if (actor.actorType === ACTOR_TYPE.SYSTEM) {
    return `system${actor.actorId ? ` (${actor.actorId})` : ""}`;
  }
  const who = actor.actorEmail || (actor.actorId ? `user ${actor.actorId}` : "staff user");
  return actor.actorIp ? `${who} from ${actor.actorIp}` : who;
}
