require("dotenv").config();
const prisma = require("../lib/prisma");
const { getAllLocations } = require("../lib/mondayClient");
const companyCam = require("../services/companyCamService");

/**
 * Bulk sync existing Monday Locations to CompanyCam
 */
async function runBulkSync() {
  console.log("[syncCompanyCam] Starting bulk sync...");

  try {
    const locations = await getAllLocations();
    console.log(`[syncCompanyCam] Found ${locations.length} locations on Monday board.`);

    let syncedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const loc of locations) {
      try {
        // 1. Check if already synced in our DB
        const existingSync = await prisma.locationSync.findUnique({
          where: { mondayItemId: String(loc.id) }
        });

        if (existingSync && existingSync.companyCamProjectId) {
          console.log(`[syncCompanyCam] Skipping "${loc.name}" (Already synced: ${existingSync.companyCamProjectId})`);
          skippedCount++;
          continue;
        }

        console.log(`[syncCompanyCam] Syncing "${loc.name}"...`);

        // 2. Create in CompanyCam
        const ccProject = await companyCam.createProject({
          name: loc.name,
          address: loc.streetAddress,
          city: loc.city,
          state: loc.state,
          zip: loc.zip
        });

        if (ccProject && ccProject.id) {
          // 3. Save mapping
          await prisma.locationSync.upsert({
            where: { mondayItemId: String(loc.id) },
            update: { companyCamProjectId: String(ccProject.id) },
            create: {
              mondayItemId: String(loc.id),
              companyCamProjectId: String(ccProject.id)
            }
          });
          syncedCount++;
          console.log(`[syncCompanyCam] ✓ Successfully synced "${loc.name}" to CC Project ${ccProject.id}`);
        } else {
          throw new Error("CC Project creation returned no ID.");
        }

      } catch (err) {
        console.error(`[syncCompanyCam] ✗ Failed to sync "${loc.name}":`, err.message);
        errorCount++;
      }
    }

    console.log("\n[syncCompanyCam] Bulk sync completed.");
    console.log(`- Synced:  ${syncedCount}`);
    console.log(`- Skipped: ${skippedCount}`);
    console.log(`- Errors:  ${errorCount}`);

  } catch (err) {
    console.error("[syncCompanyCam] Critical sync failure:", err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runBulkSync();
