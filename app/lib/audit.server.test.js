import { describe, it, expect } from "vitest";
import {
  ACTOR_TYPE, extractClientIp, actorFromSession, actorForSchedule,
  actorForSystem, actorFromRecord, describeActor,
} from "./audit.server.js";

function req(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name) => lower[name.toLowerCase()] ?? null } };
}

describe("extractClientIp", () => {
  it("reads a plain X-Forwarded-For", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("takes the LEFT-most entry of a proxy chain — the closest to the origin client", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" })))
      .toBe("203.0.113.7");
  });

  it("falls back through the other proxy headers in order", () => {
    expect(extractClientIp(req({ "cf-connecting-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(extractClientIp(req({ "x-real-ip": "198.51.100.5" }))).toBe("198.51.100.5");
    expect(extractClientIp(req({ "true-client-ip": "198.51.100.6" }))).toBe("198.51.100.6");
  });

  it("prefers X-Forwarded-For when several are present", () => {
    expect(extractClientIp(req({
      "x-forwarded-for": "203.0.113.7",
      "cf-connecting-ip": "198.51.100.4",
    }))).toBe("203.0.113.7");
  });

  it("handles IPv6", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("strips a bracketed IPv6 with port", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "[2001:db8::1]:8443" }))).toBe("2001:db8::1");
  });

  it("strips a port from IPv4", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "203.0.113.7:54321" }))).toBe("203.0.113.7");
  });

  it("trims surrounding whitespace", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "  203.0.113.7  , 10.0.0.1" }))).toBe("203.0.113.7");
  });

  // Honesty over fabrication: a null actorIp is more useful than a made-up one.
  it("returns null when no proxy header is present", () => {
    expect(extractClientIp(req())).toBeNull();
  });

  it("returns null for empty or whitespace-only header values", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "" }))).toBeNull();
    expect(extractClientIp(req({ "x-forwarded-for": "   " }))).toBeNull();
    expect(extractClientIp(req({ "x-forwarded-for": ", , " }))).toBeNull();
  });

  it("ignores an absurdly long value rather than storing junk", () => {
    expect(extractClientIp(req({ "x-forwarded-for": "a".repeat(500) }))).toBeNull();
  });

  it("never throws on a malformed request object", () => {
    expect(extractClientIp(undefined)).toBeNull();
    expect(extractClientIp({})).toBeNull();
    expect(extractClientIp({ headers: {} })).toBeNull();
    expect(extractClientIp({ headers: { get: () => { throw new Error("boom"); } } })).toBeNull();
  });
});

describe("actorFromSession", () => {
  it("captures staff identity and IP when the session exposes them", () => {
    const actor = actorFromSession(
      req({ "x-forwarded-for": "203.0.113.7" }),
      { userId: 12345n, email: "staff@merchant.com", shop: "merchant.myshopify.com" },
    );
    expect(actor).toEqual({
      actorType: ACTOR_TYPE.USER,
      actorId: "12345",
      actorEmail: "staff@merchant.com",
      actorIp: "203.0.113.7",
    });
  });

  it("coerces a BigInt userId to a string so it survives JSON and the DB", () => {
    const actor = actorFromSession(req(), { userId: 999999999999n });
    expect(actor.actorId).toBe("999999999999");
    expect(typeof actor.actorId).toBe("string");
  });

  // This app uses OFFLINE sessions, which are shop-keyed, so user identity
  // is frequently absent. It must still record that a HUMAN acted.
  it("still records actorType 'user' when the offline session carries no staff identity", () => {
    const actor = actorFromSession(req({ "x-forwarded-for": "203.0.113.7" }), { shop: "merchant.myshopify.com" });
    expect(actor.actorType).toBe(ACTOR_TYPE.USER); // not downgraded to system
    expect(actor.actorId).toBeNull();
    expect(actor.actorEmail).toBeNull();
    expect(actor.actorIp).toBe("203.0.113.7");
  });

  it("tolerates a missing session entirely", () => {
    const actor = actorFromSession(req(), null);
    expect(actor.actorType).toBe(ACTOR_TYPE.USER);
    expect(actor.actorId).toBeNull();
  });

  it("accepts an explicit actorType override", () => {
    expect(actorFromSession(req(), {}, { actorType: ACTOR_TYPE.SYSTEM }).actorType).toBe(ACTOR_TYPE.SYSTEM);
  });
});

describe("actorForSchedule / actorForSystem", () => {
  it("attributes a scheduled run to the schedule, with no IP", () => {
    expect(actorForSchedule("sched-1")).toEqual({
      actorType: ACTOR_TYPE.SCHEDULE, actorId: "sched-1", actorEmail: null, actorIp: null,
    });
  });

  it("attributes a system action with an optional reason", () => {
    expect(actorForSystem("auto-resume")).toEqual({
      actorType: ACTOR_TYPE.SYSTEM, actorId: "auto-resume", actorEmail: null, actorIp: null,
    });
  });
});

describe("actorFromRecord", () => {
  it("reads an actor back off a persisted job", () => {
    expect(actorFromRecord({
      actorType: "user", actorId: "42", actorEmail: "a@b.com", actorIp: "203.0.113.7",
    })).toEqual({ actorType: "user", actorId: "42", actorEmail: "a@b.com", actorIp: "203.0.113.7" });
  });

  it("returns an unknown actor for a null record instead of throwing", () => {
    expect(actorFromRecord(null).actorType).toBe(ACTOR_TYPE.UNKNOWN);
  });

  it("defaults a record with no attribution to unknown", () => {
    expect(actorFromRecord({}).actorType).toBe(ACTOR_TYPE.UNKNOWN);
  });
});

describe("describeActor", () => {
  it("names the human and their IP when both are known", () => {
    expect(describeActor({ actorType: "user", actorEmail: "a@b.com", actorIp: "203.0.113.7" }))
      .toBe("a@b.com from 203.0.113.7");
  });

  it("falls back to the user id when there is no email", () => {
    expect(describeActor({ actorType: "user", actorId: "42", actorIp: "203.0.113.7" }))
      .toBe("user 42 from 203.0.113.7");
  });

  it("does not invent detail it does not have", () => {
    expect(describeActor({ actorType: "user" })).toBe("staff user");
    expect(describeActor({ actorType: "unknown" })).toBe("unknown actor");
    expect(describeActor(null)).toBe("unknown actor");
  });

  it("describes schedule and system actors", () => {
    expect(describeActor({ actorType: "schedule", actorId: "sched-1" })).toBe("scheduled sync (sched-1)");
    expect(describeActor({ actorType: "system", actorId: "auto-resume" })).toBe("system (auto-resume)");
  });
});
