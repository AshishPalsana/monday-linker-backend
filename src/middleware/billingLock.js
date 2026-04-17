const prisma = require("../lib/prisma");

/**
 * Middleware to prevent modifications to resources associated with a locked Work Order.
 * A Work Order is locked when Billing Stage is 'Sent to Xero' or 'Billed'.
 */
async function requireBillingLock(req, res, next) {
  // Only mutations are blocked
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  try {
    let workOrderRef = null;

    // 1. Identify Work Order from request
    // Case A: Work Order ID provided in body (e.g. clock-in, create expense, prepare-invoice)
    if (req.body.workOrderRef) {
      workOrderRef = req.body.workOrderRef;
    } else if (req.body.workOrderId) {
      workOrderRef = req.body.workOrderId;
    }

    // Case B: Resource ID provided in params (e.g. update time entry, update expense)
    // We need to fetch the resource to find its associated Work Order
    if (!workOrderRef && req.params.id) {
      const path = req.baseUrl;
      if (path.includes("time-entries") && prisma.timeEntry) {
        const entry = await prisma.timeEntry.findUnique({ where: { id: req.params.id } });
        workOrderRef = entry?.workOrderRef;
      } else if (path.includes("expenses") && prisma.expense) {
        const expense = await prisma.expense.findUnique({ 
          where: { id: req.params.id },
          include: { timeEntry: true }
        });
        workOrderRef = expense?.timeEntry?.workOrderRef;
      }
    }

    if (!workOrderRef) {
      return next(); // No associated WO, no lock to check
    }

    // 2. Check Lock Status in local DB
    // We fetch or upsert the Work Order record to check isLocked
    if (!prisma.workOrder) {
      console.warn("[billingLock] prisma.workOrder model is missing from generated client.");
      return next();
    }

    const wo = await prisma.workOrder.findUnique({ where: { id: workOrderRef } });

    if (wo?.isLocked) {
      return res.status(403).json({
        error: "Billing Lock Active",
        message: "This Work Order has been finalized/billed and can no longer be modified."
      });
    }

    next();
  } catch (err) {
    console.error("[billingLock] Error checking lock:", err.message);
    next(); // Fail open for now to avoid blocking production
  }
}

module.exports = { requireBillingLock };
