const monday = require("../lib/mondayClient");
const prisma = require("../lib/prisma");
const xero = require("./xeroService");

/**
 * Recalculates and updates the Total Job Cost for a Work Order
 * by summing all its linked items in the Master Costs board.
 * Also syncs individual costs to the Xero Project if linked.
 *
 * @param {string} workOrderId       - Monday item ID of the Work Order
 * @param {object} [opts]
 * @param {string} [opts.forceResyncItemId] - Monday item ID of a specific cost item whose
 *   cost-relevant fields just changed; that item will be re-synced to Xero even if it
 *   already has an XERO_SYNC_ID (old entry is deleted first via syncMasterCostItemToXero).
 */
async function aggregateWorkOrderCosts(workOrderId, { forceResyncItemId = null } = {}) {
  if (!workOrderId) return;

  console.log(`[aggregation] Processing costs for Work Order ${workOrderId}${forceResyncItemId ? ` (force-resync item ${forceResyncItemId})` : ""}...`);

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

    // 2. Sync to Xero Project if linked
    const syncMapping = await prisma.workOrderSync.findUnique({
      where: { mondayItemId: String(workOrderId) }
    });

    if (syncMapping?.xeroProjectId) {
      console.log(`[aggregation] Syncing costs to Xero Project ${syncMapping.xeroProjectId}...`);

      for (const item of costs) {
        const xeroSyncCol    = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.XERO_SYNC_ID);
        const existingXeroId = xeroSyncCol?.text?.trim() || null;
        const isForceResync  = forceResyncItemId && String(item.id) === String(forceResyncItemId);

        if (existingXeroId && !isForceResync) {
          console.log(`[aggregation] Item ${item.id} already synced to Xero (id=${existingXeroId}) — skipping.`);
          continue;
        }

        const typeCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.TYPE);
        const qtyCol   = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.QUANTITY);
        const totalCol = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.TOTAL_COST);
        const rateCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.RATE);
        const dateCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.DATE);
        const descCol  = item.column_values.find(cv => cv.id === monday.COL.MASTER_COSTS.DESCRIPTION);

        const type        = typeCol?.text;  // "Labor", "Parts", "Expense"
        const quantity    = parseFloat(qtyCol?.text || 0);
        const rate        = parseFloat(rateCol?.text || 0);
        const totalCost   = parseFloat(totalCol?.text || 0) || parseFloat((quantity * rate).toFixed(2));
        const date        = dateCol?.text || new Date().toISOString().split("T")[0];
        const description = descCol?.text || item.name || "Project Cost";

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
          if (syncId !== existingXeroId) {
            await monday.updateMasterCostItem(item.id, { xeroSyncId: syncId });
          }
          console.log(`[aggregation] ✓ Item ${item.id} synced to Xero — xeroSyncId=${syncId}`);
        } catch (xeroErr) {
          console.error(`[aggregation] Xero sync failed for item ${item.id}:`, xeroErr.message);
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
