const express = require("express");
const { body, param, query } = require("express-validator");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const monday = require("../lib/mondayClient");
const prisma = require("../lib/prisma");
const { syncMasterCostItemToXero, deleteXeroSyncEntry } = require("../services/xeroService");

const router = express.Router();
router.use(requireAuth);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolves the Xero Project ID for a given Work Order Monday item ID.
 * Returns null if the WO is not yet synced to Xero.
 */
async function getXeroProjectId(workOrderMondayId) {
  if (!workOrderMondayId) return null;
  try {
    const record = await prisma.workOrderSync.findUnique({
      where: { mondayItemId: String(workOrderMondayId) },
    });
    return record?.xeroProjectId || null;
  } catch (err) {
    console.warn(`[masterCosts] Could not look up WorkOrderSync for ${workOrderMondayId}:`, err.message);
    return null;
  }
}

/**
 * Attempts to sync a master cost item to the linked Xero Project.
 * Silently skips if Xero is not connected or the WO has no project.
 * Returns the encoded xeroSyncId ("TIME:uuid" or "TASK:uuid") or null.
 */
async function attemptXeroSync({ mondayItemId, workOrderMondayId, existingXeroSyncId, type, name, description, quantity, rate, totalCost, date }) {
  const xeroProjectId = await getXeroProjectId(workOrderMondayId);
  if (!xeroProjectId) {
    console.log(`[masterCosts] Xero sync skipped — no Xero project for WO ${workOrderMondayId}`);
    return null;
  }

  try {
    const xeroSyncId = await syncMasterCostItemToXero({
      pulseId: mondayItemId,
      xeroProjectId,
      existingXeroSyncId: existingXeroSyncId || null,
      type,
      description: name || description,
      quantity,
      rate,
      totalCost,
      date,
    });
    console.log(`[masterCosts] ✓ Xero sync — xeroSyncId=${xeroSyncId}`);
    return xeroSyncId;
  } catch (xeroErr) {
    console.warn(`[masterCosts] Xero sync failed (non-fatal):`, xeroErr.message);
    return null;
  }
}

// ─── GET /api/master-costs?workOrderId=<mondayItemId> ─────────────────────────
router.get(
  "/",
  [query("workOrderId").optional().isString()],
  validate,
  async (req, res, next) => {
    try {
      const { workOrderId } = req.query;
      const items = await monday.getMasterCosts(workOrderId || null);
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.json({ data: items });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/master-costs ───────────────────────────────────────────────────
router.post(
  "/",
  [
    body("workOrderId").isString().notEmpty().withMessage("workOrderId required"),
    body("name").optional().isString(),
    body("type")
      .isIn(["Labor", "Parts", "Expense"])
      .withMessage("type must be Labor, Parts, or Expense"),
    body("quantity").isFloat({ min: 0 }).withMessage("quantity must be >= 0"),
    body("rate").isFloat({ min: 0 }).withMessage("rate must be >= 0"),
    body("description").optional().isString(),
    body("date").optional().isString(),
    body("workOrderLabel").optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { workOrderId, workOrderLabel, name, type, quantity, rate, description, date } = req.body;
      const qty = parseFloat(quantity);
      const rt = parseFloat(rate);
      const totalCost = parseFloat((qty * rt).toFixed(2));

      const created = await monday.createMasterCostItem({
        workOrderId,
        workOrderLabel: workOrderLabel || "",
        name,
        type,
        quantity: qty,
        rate: rt,
        totalCost,
        description: description || "",
        date: date || null,
        mondayUserId: req.technician.mondayUserId || null,
      });

      // 2. Trigger Xero sync immediately
      const xeroSyncId = await attemptXeroSync({
        mondayItemId: created.id,
        workOrderMondayId: workOrderId,
        type,
        name,
        description,
        quantity: qty,
        rate: rt,
        totalCost,
        date: date || null,
      });

      // 3. Update the item in Monday with the Xero ID if sync was successful
      if (xeroSyncId) {
        await monday.updateMasterCostItem(created.id, { xeroSyncId }).catch((err) => {
          console.warn(`[masterCosts] Failed to save xeroSyncId to Monday:`, err.message);
        });
      }

      res.status(201).json({ data: created });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /api/master-costs/:mondayItemId ────────────────────────────────────
router.patch(
  "/:mondayItemId",
  [
    param("mondayItemId").isString().notEmpty(),
    body("name").optional().isString(),
    body("workOrderId").optional().isString(),
    body("type").optional().isIn(["Labor", "Parts", "Expense"]),
    body("quantity").optional().isFloat({ min: 0 }),
    body("rate").optional().isFloat({ min: 0 }),
    body("description").optional().isString(),
    body("date").optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { mondayItemId } = req.params;
      const { name, type, quantity, rate, description, date, workOrderId } = req.body;

      // Fetch current item from Monday to get existing Xero sync ID and WO relation
      let existingXeroSyncId = null;
      let resolvedWorkOrderId = workOrderId || null;

      const currentItem = await monday.getMasterCostItem(mondayItemId).catch((err) => {
        console.warn(`[masterCosts] Could not fetch current item ${mondayItemId}:`, err.message);
        return null;
      });

      if (currentItem) {
        const xeroSyncCol = currentItem.column_values.find(
          (c) => c.id === monday.COL.MASTER_COSTS.XERO_SYNC_ID,
        );
        existingXeroSyncId = xeroSyncCol?.text || null;

        if (!resolvedWorkOrderId) {
          const relCol = currentItem.column_values.find(
            (c) => c.id === monday.COL.MASTER_COSTS.WORK_ORDERS_REL,
          );
          const linkedIds = relCol?.linked_item_ids;
          resolvedWorkOrderId = Array.isArray(linkedIds) && linkedIds.length
            ? String(linkedIds[0])
            : null;
        }
      }

      // Build column updates
      const updates = {};
      if (name        !== undefined) updates.name        = name;
      if (type        !== undefined) updates.type        = type;
      if (description !== undefined) updates.description = description;
      if (date        !== undefined) updates.date        = date;
      if (quantity    !== undefined) updates.quantity    = parseFloat(quantity);
      if (rate        !== undefined) updates.rate        = parseFloat(rate);
      if (quantity !== undefined || rate !== undefined) {
        const q = quantity !== undefined ? parseFloat(quantity) : null;
        const r = rate     !== undefined ? parseFloat(rate)     : null;
        if (q !== null && r !== null) {
          updates.totalCost = parseFloat((q * r).toFixed(2));
        }
      }

      await monday.updateMasterCostItem(mondayItemId, updates);

      // Xero sync — only when fields that affect cost/type/description changed
      const xeroRelevantChanged = [type, quantity, rate, description, date].some(
        (v) => v !== undefined,
      );
      let newXeroSyncId = existingXeroSyncId;

      if (xeroRelevantChanged) {
        const effectiveType        = updates.type        ?? currentItem?.column_values?.find(c => c.id === monday.COL.MASTER_COSTS.TYPE)?.text;
        const effectiveDescription = updates.description ?? currentItem?.column_values?.find(c => c.id === monday.COL.MASTER_COSTS.DESCRIPTION)?.text;
        const effectiveQuantity    = updates.quantity    ?? parseFloat(currentItem?.column_values?.find(c => c.id === monday.COL.MASTER_COSTS.QUANTITY)?.text || 0);
        const effectiveRate        = updates.rate        ?? parseFloat(currentItem?.column_values?.find(c => c.id === monday.COL.MASTER_COSTS.RATE)?.text || 0);
        const effectiveTotalCost   = updates.totalCost   ?? parseFloat(currentItem?.column_values?.find(c => c.id === monday.COL.MASTER_COSTS.TOTAL_COST)?.text || 0);
        const effectiveDate        = updates.date        ?? currentItem?.column_values?.find(c => c.id === monday.COL.MASTER_COSTS.DATE)?.text;

        const effectiveName = updates.name ?? currentItem?.name;

        const syncedId = await attemptXeroSync({
          mondayItemId,
          workOrderMondayId: resolvedWorkOrderId,
          existingXeroSyncId,
          type: effectiveType,
          name: effectiveName,
          description: effectiveDescription,
          quantity: effectiveQuantity,
          rate: effectiveRate,
          totalCost: effectiveTotalCost,
          date: effectiveDate,
        });

        if (syncedId !== null && syncedId !== existingXeroSyncId) {
          await monday.updateMasterCostItem(mondayItemId, { xeroSyncId: syncedId }).catch((err) => {
            console.warn(`[masterCosts] Could not write xeroSyncId to Monday item ${mondayItemId}:`, err.message);
          });
          newXeroSyncId = syncedId;
        }
      }

      res.json({ data: { mondayItemId, ...updates, xeroSyncId: newXeroSyncId } });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /api/master-costs/:mondayItemId ───────────────────────────────────
router.delete(
  "/:mondayItemId",
  requireAdmin,
  [param("mondayItemId").isString().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const { mondayItemId } = req.params;

      // Fetch current item to get XERO_SYNC_ID and work order relation before deleting
      const currentItem = await monday.getMasterCostItem(mondayItemId).catch(() => null);

      if (currentItem) {
        const xeroSyncCol = currentItem.column_values.find(c => c.id === monday.COL.MASTER_COSTS.XERO_SYNC_ID);
        const xeroSyncId  = xeroSyncCol?.text?.trim() || null;

        if (xeroSyncId && !xeroSyncId.startsWith("synced-")) {
          const relCol  = currentItem.column_values.find(c => c.id === monday.COL.MASTER_COSTS.WORK_ORDERS_REL);
          const linkedIds = relCol?.linked_item_ids;
          const workOrderMondayId = Array.isArray(linkedIds) && linkedIds.length ? String(linkedIds[0]) : null;
          const xeroProjectId = await getXeroProjectId(workOrderMondayId);

          if (xeroProjectId) {
            await deleteXeroSyncEntry(xeroProjectId, xeroSyncId).catch((err) => {
              console.warn(`[masterCosts] Could not delete Xero entry ${xeroSyncId} for item ${mondayItemId}:`, err.message);
            });
            console.log(`[masterCosts] ✓ Deleted Xero entry ${xeroSyncId} for item ${mondayItemId}`);
          }
        }
      }

      await monday.deleteMasterCostItem(mondayItemId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
