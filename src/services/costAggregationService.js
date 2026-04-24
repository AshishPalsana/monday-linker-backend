const monday = require("../lib/mondayClient");
const prisma = require("../lib/prisma");
const xero = require("./xeroService");
const { tryAcquireSyncLock, releaseSyncLock } = xero;

/**
 * Recalculates and updates the Total Job Cost for a Work Order
 * by summing all its linked items in the Master Costs board.
 * Also performs the initial Xero sync for items that have no XERO_SYNC_ID yet.
 *
 * Xero UPDATES (edits) are handled exclusively by the PATCH route — not here.
 * This prevents duplicate Xero entries on multi-instance deployments where
 * in-memory state cannot be shared across server processes.
 *
 * @param {string} workOrderId - Monday item ID of the Work Order
 */
async function aggregateWorkOrderCosts(workOrderId) {
  if (!workOrderId) return;

  console.log(`[aggregation] Processing costs for Work Order ${workOrderId}...`);

  try {
    const costs = await monday.getMasterCosts(workOrderId);

    // 1. Calculate Total for Monday
    const total = costs.reduce((sum, item) => {
      const totalCol = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.TOTAL_COST);
      const val = parseFloat(totalCol?.text || 0);
      return sum + val;
    }, 0);

    console.log(`[aggregation] New total for WO ${workOrderId}: $${total.toFixed(2)}`);
    await monday.updateWorkOrderTotalCost(workOrderId, total.toFixed(2));

    // 2. Initial Xero sync for items that have never been synced yet
    const syncMapping = await prisma.workOrderSync.findUnique({
      where: { mondayItemId: String(workOrderId) }
    });

    if (syncMapping?.xeroProjectId) {
      console.log(`[aggregation] Checking for un-synced items in Xero Project ${syncMapping.xeroProjectId}...`);

      for (const item of costs) {
        const xeroSyncCol    = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.XERO_SYNC_ID);
        const existingXeroId = xeroSyncCol?.text?.trim() || null;
 
        // Skip items already synced — updates go through the PATCH/POST route only.
        // Also skip items currently being synced by the POST route (lock held) to prevent
        // duplicates in the window between Xero creation and Monday write-back.
        if (existingXeroId) {
          continue;
        }

        const lockAcquired = tryAcquireSyncLock(item.id);
        if (!lockAcquired) {
          console.log(`[aggregation] Item ${item.id} sync already in progress — skipping.`);
          continue;
        }

        // Re-fetch live xeroSyncId after acquiring the lock.
        // The snapshot (costs) may be stale if another path wrote the xeroSyncId
        // between when we fetched the cost list and now.
        try {
          const liveItem = await monday.getMasterCostItem(item.id);
          const liveXeroCol = liveItem?.column_values?.find(cv => cv.id === monday.COL.MASTER_COSTS.XERO_SYNC_ID);
          const liveXeroId = liveXeroCol?.text?.trim() || null;
          if (liveXeroId) {
            console.log(`[aggregation] Item ${item.id} already synced since snapshot — skipping.`);
            releaseSyncLock(item.id);
            continue;
          }
        } catch (fetchErr) {
          console.warn(`[aggregation] Could not re-fetch item ${item.id}:`, fetchErr.message);
          releaseSyncLock(item.id);
          continue;
        }

        const typeCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.TYPE);
        const qtyCol   = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.QUANTITY);
        const totalCol = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.TOTAL_COST);
        const rateCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.RATE);
        const dateCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.DATE);
        const descCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.DESCRIPTION);

        const type        = typeCol?.text || null;
        const quantity    = parseFloat(qtyCol?.text || 0);
        const rate        = parseFloat(rateCol?.text || 0);
        const totalCost   = parseFloat(totalCol?.text || 0) || parseFloat((quantity * rate).toFixed(2));
        const date        = dateCol?.text || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
        const description = item.name || descCol?.text || "Project Cost";

        // Skip items that have no type or zero cost — they were just created in Monday
        // and columns haven't been filled in yet. The webhook will sync once data is set.
        if (!type || (totalCost === 0 && rate === 0)) {
          console.log(`[aggregation] Item ${item.id} has no type or zero cost — deferring Xero sync`);
          releaseSyncLock(item.id);
          continue;
        }

        try {
          const newXeroSyncId = await xero.syncMasterCostItemToXero({
            xeroProjectId: syncMapping.xeroProjectId,
            existingXeroSyncId: existingXeroId,
            type,
            description,
            quantity,
            rate,
            totalCost,
            date,
          });

          const syncId = newXeroSyncId || `synced-${Date.now()}`;
          await monday.updateMasterCostItem(item.id, { xeroSyncId: syncId });
          console.log(`[aggregation] ✓ Item ${item.id} initial sync to Xero — xeroSyncId=${syncId}`);
        } catch (xeroErr) {
          console.error(`[aggregation] Xero sync failed for item ${item.id}:`, xeroErr.message);
        } finally {
          releaseSyncLock(item.id);
        }
      }
    }

    return total;
  } catch (err) {
    console.error(`[aggregation] Error for WO ${workOrderId}:`, err.message);
    throw err;
  }
}

module.exports = {
  aggregateWorkOrderCosts,
};
