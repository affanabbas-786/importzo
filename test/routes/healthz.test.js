import { describe, it, expect, vi, beforeEach } from "vitest";

const queryRawUnsafe = vi.fn();

vi.mock("../../app/db.server", () => ({
  default: {
    get $queryRawUnsafe() {
      return queryRawUnsafe;
    },
  },
}));

const { loader } = await import("../../app/routes/healthz.jsx");

describe("/healthz (public uptime-monitoring target)", () => {
  beforeEach(() => {
    queryRawUnsafe.mockReset();
  });

  it("returns 200 with status ok when the DB responds", async () => {
    queryRawUnsafe.mockResolvedValue([{ "1": 1 }]);

    const response = await loader({});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("returns 503 with status error when the DB check throws", async () => {
    queryRawUnsafe.mockRejectedValue(new Error("db down"));

    const response = await loader({});
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.status).toBe("error");
    expect(body.checks.db).toBe("error");
  });

  it("requires no authentication (loader takes no request/auth args)", async () => {
    queryRawUnsafe.mockResolvedValue([{ "1": 1 }]);
    // Called with an empty object — no request, no session — and still succeeds.
    await expect(loader({})).resolves.toBeInstanceOf(Response);
  });
});
