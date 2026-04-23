const express = require("express");
const { param } = require("express-validator");
const prisma = require("../lib/prisma");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const monday = require("../lib/mondayClient");
const { requireBillingLock } = require("../middleware/billingLock");
const { createXeroInvoice } = require("../services/xeroService");

const router = express.Router();

router.post(
  "/work-orders/:id/prepare-invoice",
  requireAdmin,
  [param("id").isString().notEmpty()],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const workOrderMondayId = req.params.id;

      // ── 1. Load Master Costs ─────────────────────────────────────────────
      const costs = await monday.getMasterCosts(workOrderMondayId);
      if (!costs.length) {
        return res.status(400).json({ error: "No Master Costs found for this Work Order" });
      }

      // ── 2. Load markup settings ──────────────────────────────────────────
      let settings = await prisma.globalSettings.findUnique({ where: { id: "default" } });
      if (!settings) {
        settings = await prisma.globalSettings.create({
          data: { id: "default", partsMarkup: 1.35, expenseMarkup: 1.10 },
        });
      }

      const results = { promoted: 0, skipped: 0, errors: [] };
      const promotedItems = []; // collect for Xero invoice

      // ── 3. Promote each cost to Invoice Line Items on Monday ─────────────
      for (const cost of costs) {
        try {
          const statusVal = cost.column_values
            .find((c) => c.id === monday.COL.MASTER_COSTS.INVOICE_STATUS)?.text;

          if (statusVal === "Invoiced" || statusVal === "Billed") {
            results.skipped++;
            continue;
          }

          const type        = cost.column_values.find((c) => c.id === monday.COL.MASTER_COSTS.TYPE)?.text;
          const qty         = parseFloat(cost.column_values.find((c) => c.id === monday.COL.MASTER_COSTS.QUANTITY)?.text || 1);
          const costRate    = parseFloat(cost.column_values.find((c) => c.id === monday.COL.MASTER_COSTS.RATE)?.text || 0);
          const description = cost.column_values.find((c) => c.id === monday.COL.MASTER_COSTS.DESCRIPTION)?.text || cost.name;

          let unitPrice = costRate;
          if (type === "Parts") {
            unitPrice = costRate * parseFloat(settings.partsMarkup);
          } else if (type === "Expense") {
            unitPrice = costRate * parseFloat(settings.expenseMarkup);
          } else if (type === "Labor") {
            // Use burden rate as billed rate; fall back to $85 if not yet configured
            unitPrice = costRate > 0 ? costRate : 85.00;
          }

          unitPrice = parseFloat(unitPrice.toFixed(2));

          const invoiceItemId = await monday.createInvoiceItem({
            workOrderId: workOrderMondayId,
            type,
            quantity: qty,
            unitPrice,
            description,
            itemName: cost.name,
          });

          // Mark the invoice item as Invoiced and the master cost as processed —
          // run in parallel since neither depends on the other's result
          await Promise.all([
            monday.setInvoiceItemStatus(invoiceItemId, "Invoiced").catch((err) =>
              console.warn(`[prepare-invoice] Could not set billing status on item ${invoiceItemId}:`, err.message)
            ),
            monday.updateMasterCostItem(cost.id, { invoiceStatus: "Invoiced" }),
          ]);

          promotedItems.push({ invoiceItemId, type, quantity: qty, unitPrice, description });
          results.promoted++;
        } catch (err) {
          console.error(`[prepare-invoice] Error promoting cost ${cost.id}:`, err.message);
          results.errors.push({ id: cost.id, error: err.message });
        }
      }

      // ── 4. Create Xero Invoice (only if anything was promoted) ───────────
      let xeroInvoice = null;

      if (promotedItems.length > 0) {
        try {
          // Resolve the customer's Xero Contact ID via the Work Order
          const wo = await monday.getWorkOrderDetails(workOrderMondayId);
          const workOrderRef = wo?.workOrderId || workOrderMondayId;

          let xeroContactId = null;
          if (wo?.customerId) {
            const custRecord = await prisma.customer.findUnique({
              where: { id: String(wo.customerId) },
              select: { xeroContactId: true },
            });
            xeroContactId = custRecord?.xeroContactId || null;
          }

          if (!xeroContactId) {
            console.warn(`[prepare-invoice] No Xero Contact for WO ${workOrderMondayId} — invoice not created in Xero`);
            results.xeroWarning = "Customer not synced to Xero. Invoice created on Monday only. Link a customer and retry to sync to Xero.";
          } else {
            xeroInvoice = await createXeroInvoice({
              xeroContactId,
              reference: workOrderRef,
              lineItems: promotedItems,
            });

            // Write the Xero invoice ID back onto every Invoice Line Item
            await Promise.allSettled(
              promotedItems.map(({ invoiceItemId }) =>
                monday.updateInvoiceItemXeroId(invoiceItemId, xeroInvoice.invoiceId).catch((err) =>
                  console.warn(`[prepare-invoice] Could not write Xero invoice ID to item ${invoiceItemId}:`, err.message)
                )
              )
            );

            results.xeroInvoice = {
              invoiceId:     xeroInvoice.invoiceId,
              invoiceNumber: xeroInvoice.invoiceNumber,
              invoiceUrl:    xeroInvoice.invoiceUrl,
            };
            console.log(`[prepare-invoice] ✓ Xero invoice created — ${xeroInvoice.invoiceNumber} (${xeroInvoice.invoiceId})`);
          }
        } catch (xeroErr) {
          console.error(`[prepare-invoice] Xero invoice creation failed:`, xeroErr.message);
          // Non-fatal: Monday items were already promoted. Surface the error so admin knows.
          results.xeroError = xeroErr.message;
        }
      }

      res.json({ data: results });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
