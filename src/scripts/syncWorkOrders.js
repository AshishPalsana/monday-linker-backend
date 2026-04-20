require("dotenv").config();
const prisma = require("../lib/prisma");
const { getActiveWorkOrders } = require("../lib/mondayClient");

/**
 * Bulk sync Work Order assignments from Monday.com to the local DB.
 * This serves as a safety net for missed/delayed webhooks.
 */
async function runAssignmentSync() {
  console.log("[syncWorkOrders] Starting bulk assignment sync...");

  try {
    const workOrders = await getActiveWorkOrders();
    console.log(`[syncWorkOrders] Found ${workOrders.length} active work orders on Monday.`);

    let updatedCount = 0;
    let errorCount = 0;

    for (const wo of workOrders) {
      try {
        // Atomic update to prevent race conditions and ensure idempotency
        await prisma.workOrder.upsert({
          where: { id: String(wo.id) },
          update: { 
            assignedTechnicianIds: wo.assignedTechnicianIds,
            workOrderId: wo.workOrderId || undefined
          },
          create: {
            id: String(wo.id),
            workOrderId: wo.workOrderId || "",
            assignedTechnicianIds: wo.assignedTechnicianIds
          }
        });
        updatedCount++;
        if (updatedCount % 20 === 0) {
          console.log(`[syncWorkOrders] Progress: ${updatedCount}/${workOrders.length}...`);
        }
      } catch (err) {
        console.error(`[syncWorkOrders] ✗ Failed to sync WO ${wo.id} (${wo.name}):`, err.message);
        errorCount++;
      }
    }

    console.log("\n[syncWorkOrders] Assignment sync completed.");
    console.log(`- Updated: ${updatedCount}`);
    console.log(`- Errors:  ${errorCount}`);

  } catch (err) {
    console.error("[syncWorkOrders] Critical sync failure:", err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runAssignmentSync();
