// Turns a ScheduledSync row into a queued MigrationJob.
//
// Lives here rather than in api.scheduled-sync.jsx because React Router only
// treats loader/action/middleware/headers as server-only route exports. Any
// OTHER export from a route module gets pulled into the client bundle along
// with everything it imports — which meant exporting this from the route
// leaked shopify.server (and Prisma) into the browser build and broke it.
// The .server.js suffix is the honored server-only convention, same as
// db.server.js.

import prisma from "../db.server.js";
import { apiVersion } from "../shopify.server.js";
import { encrypt, decrypt } from "../utils/encryption.server.js";
import { actorForSchedule } from "./audit.server.js";

export async function startJobFromSchedule(schedule) {
  const job = await prisma.migrationJob.create({
    data: {
      // Phase 3.7: attributed to the schedule, not a human — there is no
      // request, no session and no IP behind a cron-driven run.
      ...actorForSchedule(schedule.id),
      shop: schedule.shop,
      sourceShop: schedule.sourceShop,
      // Stored encrypted on the schedule; MigrationJob stores its own
      // encrypted copy, so decrypt and re-encrypt rather than assuming the
      // two models will always share an encryption scheme.
      sourceToken: encrypt(decrypt(schedule.sourceToken)),
      destToken: encrypt(decrypt(schedule.destToken)),
      apiVersion: apiVersion || "2026-04",
      conflictMode: schedule.conflictMode || "skip",
      status: "PENDING",
    },
  });
  return job.id;
}
