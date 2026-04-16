const express = require("express");
const { param } = require("express-validator");
const prisma = require("../lib/prisma");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const monday = require("../lib/mondayClient");
const { requireBillingLock } = require("../middleware/billingLock");

const router = express.Router();
router.use(requireAuth);

/**
 * Prepares an invoice by promoting Master Costs to Invoice Line Items.
 * Idempotent: Only promotes items that haven't been promoted yet.
 */
router.post(
  "/work-orders/:id/prepare-invoice",
  requireAdmin,
  [param("id").isString().notEmpty()],
  validate,
  requireBillingLock,
  async (req, res, next) => {
    try {
      const workOrderId = req.params.id;

      // 1. Fetch all Master Costs for this Work Order
      const costs = await monday.getMasterCosts(workOrderId);
      if (!costs.length) {
        return res.status(400).json({ error: "No Master Costs found for this Work Order" });
      }

      // 2. Fetch Global Settings for markups
      let settings = await prisma.globalSettings.findUnique({ where: { id: "default" } });
      if (!settings) {
        // Create default if missing
        settings = await prisma.globalSettings.create({
          data: { id: "default", partsMarkup: 1.35, expenseMarkup: 1.10 }
        });
      }

      const results = {
        promoted: 0,
        skipped: 0,
        errors: []
      };

      // 3. Promote items 1:1
      for (const cost of costs) {
        try {
          // Check if already promoted (using the INVOICE_STATUS column as a proxy for now, 
          // or we can add a dedicated board_relation column for exact linking)
          const statusVal = cost.column_values.find(c => c.id === monday.COL.MASTER_COSTS.INVOICE_STATUS)?.text;
          
          if (statusVal === "Invoiced" || statusVal === "Billed") {
            results.skipped++;
            continue;
          }

          const type = cost.column_values.find(c => c.id === monday.COL.MASTER_COSTS.TYPE)?.text;
          const qty = parseFloat(cost.column_values.find(c => c.id === monday.COL.MASTER_COSTS.QUANTITY)?.text || 1);
          const costRate = parseFloat(cost.column_values.find(c => c.id === monday.COL.MASTER_COSTS.RATE)?.text || 0);
          const description = cost.column_values.find(c => c.id === monday.COL.MASTER_COSTS.DESCRIPTION)?.text || cost.name;

          // Apply Pricing Strategy
          let unitPrice = costRate;
          if (type === "Parts") {
            unitPrice = costRate * parseFloat(settings.partsMarkup);
          } else if (type === "Expense") {
            unitPrice = costRate * parseFloat(settings.expenseMarkup);
          } else if (type === "Labor") {
            // Labor billing rate is usually fixed/predefined per tech or job
            // For now, using the rate as-is or applying a default
            unitPrice = costRate > 0 ? costRate : 85.00; 
          }

          // Create Invoice Item
          const invoiceItemId = await monday.createInvoiceItem({
            workOrderId,
            type,
            quantity: qty,
            unitPrice,
            description,
            itemName: cost.name
          });

          // Update Master Cost status to 'Invoiced'
          await monday.updateMasterCostItem(cost.id, {
            // We use the status column to flag it
            invoiceStatus: "Invoiced" 
          });

          results.promoted++;
        } catch (err) {
          console.error(`[prepare-invoice] Error promoting cost ${cost.id}:`, err.message);
          results.errors.push({ id: cost.id, error: err.message });
        }
      }

      res.json({ data: results });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
