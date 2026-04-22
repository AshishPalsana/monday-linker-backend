const prisma = require("../lib/prisma");
const xeroService = require("./xeroService");
const {
  updateCustomerXeroStatus,
  updateCustomerXeroId,
  getCustomerDetails
} = require("../lib/mondayClient");
const { emitCustomerSync } = require("../lib/socketServer");

async function syncCustomerToXero(pulseId) {
  console.log(`[customerSyncService] Starting sync for pulse ${pulseId}…`);

  // 1. Fetch current record version from DB
  const customer = await prisma.customer.findUnique({
    where: { id: String(pulseId) }
  });

  if (!customer) {
    console.error(`[customerSyncService] Error: Customer ${pulseId} not found in DB.`);
    return;
  }

  const originalVersion = customer.syncVersion;

  try {
    // 2. Pre-sync Validation
    const missing = [];
    if (!customer.name) missing.push("Name");
    if (!customer.addressLine1) missing.push("Address Line 1");
    if (!customer.city) missing.push("City");
    if (!customer.country) missing.push("Country");

    if (missing.length > 0) {
      throw new Error(`Validation Failed: Missing required fields (${missing.join(", ")})`);
    }

    // 3. Perform Xero Sync (Idempotent)
    const xeroContactId = await xeroService.createXeroContact({
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      addressLine1: customer.addressLine1,
      addressLine2: customer.addressLine2,
      city: customer.city,
      state: customer.state,
      zip: customer.zip,
      country: customer.country,
      accountNumber: customer.accountNumber,
      xeroContactId: customer.xeroContactId
    });

    // 4. Update Database (Atomic Check)
    // We only update if the syncVersion hasn't changed while we were talking to Xero
    const updated = await prisma.customer.updateMany({
      where: {
        id: String(pulseId),
        syncVersion: originalVersion
      },
      data: {
        xeroSyncStatus: "Synced",
        xeroContactId: xeroContactId,
        syncErrorMessage: null,
        syncErrorCode: null,
        lastSyncAt: new Date(),
        // Increment version to mark this state as definitive
        syncVersion: { increment: 1 }
      }
    });

    if (updated.count === 0) {
      console.warn(`[customerSyncService] Stale sync discarded for ${pulseId} (Newer update already exists).`);
      return;
    }

    // 5. Update Monday Board (Consistency)
    try {
      await updateCustomerXeroId(pulseId, xeroContactId);
      await updateCustomerXeroStatus(pulseId, "Synced");
      console.log(`[customerSyncService] ✓ Sync complete for ${customer.name}`);
    } catch (monErr) {
      console.error(`[customerSyncService] Monday update failed for ${pulseId}:`, monErr.message);
      // Note: We don't mark as Failed because Xero/DB are correct.
      // A recovery sweep can eventually fix the Monday display.
    }

    // 6. Notify frontend so it can refresh without polling
    emitCustomerSync({ customerId: pulseId, xeroContactId, xeroSyncStatus: "Synced" });

  } catch (err) {
    console.error(`[customerSyncService] ✗ Sync failed for ${customer.name}:`, err.message);

    // Update DB with error details
    await prisma.customer.updateMany({
      where: {
        id: String(pulseId),
        syncVersion: originalVersion
      },
      data: {
        xeroSyncStatus: "Failed",
        syncErrorMessage: err.message,
        syncErrorCode: err.code || "SYNC_ERROR",
        lastSyncAt: new Date()
      }
    });

    // Update Monday status
    try {
      await updateCustomerXeroStatus(pulseId, "Error");
    } catch (monErr) {
      console.error(`[customerSyncService] Failed to update Monday error status for ${pulseId}`);
    }
  }
}

/**
 * Recovery Sweep: Finds any customers stuck in 'Pending' and restarts their sync.
 */
async function runRecoverySweep() {
  console.log("[customerSyncService] Running recovery sweep for Pending records…");
  try {
    if (!prisma.customer) {
      console.warn("[customerSyncService] prisma.customer model is missing from generated client.");
      return;
    }
    const pending = await prisma.customer.findMany({
      where: { xeroSyncStatus: "Pending" }
    });

    if (pending.length === 0) {
      console.log("[customerSyncService] No pending records found.");
      return;
    }

    console.log(`[customerSyncService] Found ${pending.length} pending records to re-process.`);
    for (const record of pending) {
      // Small delay between each to avoid thundering herd
      await new Promise(r => setTimeout(r, 500));
      syncCustomerToXero(record.id);
    }
  } catch (err) {
    console.error("[customerSyncService] Recovery sweep failed:", err.message);
  }
}

module.exports = {
  syncCustomerToXero,
  runRecoverySweep
};
