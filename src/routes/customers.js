const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { body } = require("express-validator");
const { combineAddress } = require("../utils/addressUtils");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { syncCustomerToXero } = require("../services/customerSyncService");
const { createXeroContact } = require("../services/xeroService");
const {
  getCustomerDetails,
  getAllCustomers,
  updateCustomerBillingDetails,
  updateCustomerXeroStatus,
  updateCustomerXeroId,
} = require("../lib/mondayClient");

// router.use(requireAuth);

/**
 * GET /api/customers/:id
 * Fetches a single customer's structured data (address, sync status) from DB.
 */
router.get("/:id", async (req, res, next) => {
  const pulseId = req.params.id;
  try {
    let customer = await prisma.customer.findUnique({
      where: { id: pulseId },
    });

    if (!customer) {
      console.log(`[api/customers] Customer ${pulseId} not found in DB. Fetching from Monday fallback…`);
      const mondayData = await getCustomerDetails(pulseId);
      if (mondayData) {
        // Return a skeleton matching the DB structure
        return res.json({
          success: true,
          data: {
            id: pulseId,
            name: mondayData.name,
            email: mondayData.email,
            phone: mondayData.phone,
            billingAddress: mondayData.address,
            // Rest are nulls/defaults
          }
        });
      }
      return res.status(404).json({ error: "Customer not found in DB or Monday." });
    }

    res.json({ success: true, data: customer });
  } catch (err) {
    console.error(`[api/customers] GET /:id failed:`, err.message);
    next(err);
  }
});

router.post("/upsert",
  [
    body("id").isString().notEmpty().withMessage("Monday Item ID (id) is required"),
    body("name").isString().trim().notEmpty().withMessage("Name is required"),
    body("addressLine1").isString().trim().notEmpty().withMessage("Address Line 1 is required"),
    body("city").isString().trim().notEmpty().withMessage("City is required"),
    body("country").isString().trim().notEmpty().withMessage("Country is required"),
    body("addressLine2").optional({ values: "null" }).isString().trim(),
    body("state").optional({ values: "null" }).isString().trim(),
    body("zip").optional({ values: "null" }).isString().trim(),
    body("email").optional({ values: "null" }).isString().trim(),
    body("phone").optional({ values: "null" }).isString().trim(),
    body("billingTerms").optional({ values: "null" }).isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { id, name, email, phone, billingTerms, ...addressFields } = req.body;
      const pulseId = String(id);
      const billingAddressStr = combineAddress(addressFields);

      const existing = await prisma.customer.findUnique({ where: { id: pulseId } });

      const hasChanged = !existing ||
        existing.name !== name ||
        existing.email !== email ||
        existing.phone !== phone ||
        existing.addressLine1 !== addressFields.addressLine1 ||
        existing.city !== addressFields.city ||
        existing.country !== addressFields.country ||
        existing.billingTerms !== billingTerms;

      const shouldSync = hasChanged || existing?.xeroSyncStatus === "Failed";

      console.log(`[api/customers] Upsert pulse ${pulseId} — hasChanged=${hasChanged} shouldSync=${shouldSync}`);

      const customer = await prisma.customer.upsert({
        where: { id: pulseId },
        update: {
          name,
          email: email || null,
          phone: phone || null,
          billingTerms: billingTerms || null,
          ...addressFields,
          billingAddress: billingAddressStr,
          xeroSyncStatus: shouldSync ? "Pending" : undefined,
          syncVersion: shouldSync ? { increment: 1 } : undefined
        },
        create: {
          id: pulseId,
          name,
          email: email || null,
          phone: phone || null,
          billingTerms: billingTerms || null,
          ...addressFields,
          billingAddress: billingAddressStr,
          xeroSyncStatus: "Pending"
        }
      });

      setImmediate(async () => {
        try {
          await updateCustomerBillingDetails(pulseId, billingAddressStr, billingTerms);
          if (shouldSync) {
            await updateCustomerXeroStatus(pulseId, "Not Synced");
            await syncCustomerToXero(pulseId);
          }
        } catch (err) {
          console.error(`[api/customers] Background post-save task failed for ${pulseId}:`, err.message);
        }
      });

      res.json({
        success: true,
        data: customer,
        syncTriggered: shouldSync
      });
    } catch (err) {
      console.error("[api/customers] Upsert failed:", err.message);
      next(err);
    }
  }
);

router.post("/:id/retry", async (req, res, next) => {
  const pulseId = req.params.id;
  try {
    await prisma.customer.update({
      where: { id: pulseId },
      data: {
        xeroSyncStatus: "Pending",
        syncVersion: { increment: 1 }
      }
    });

    setImmediate(() => syncCustomerToXero(pulseId));

    res.json({ success: true, message: "Sync retry initiated." });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/customers/sync-all
 * Backfills Xero Contact IDs for every customer already on the Monday Customers board.
 * Safe to call repeatedly — skips any customer that already has a valid xeroContactId in DB.
 * For customers that exist in Xero, the lookup-before-create logic in createXeroContact
 * finds them by account number or name instead of creating duplicates.
 */
router.post("/sync-all", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const mondayCustomers = await getAllCustomers();
    if (!mondayCustomers.length) {
      return res.json({ data: { synced: 0, skipped: 0, errors: [] } });
    }

    // Load all existing DB records in one query for fast lookup
    const dbRecords = await prisma.customer.findMany({
      select: { id: true, xeroContactId: true },
    });
    const dbMap = new Map(dbRecords.map((r) => [r.id, r.xeroContactId]));

    const results = { synced: 0, skipped: 0, errors: [] };
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (const cust of mondayCustomers) {
      const custId = String(cust.id);

      // Skip if DB already has a valid Xero UUID (guards against "[object Object]" corruption)
      const existingXeroId = dbMap.get(custId);
      if (existingXeroId && UUID_RE.test(existingXeroId)) {
        results.skipped++;
        continue;
      }

      // If Monday board column already has a valid Xero Contact ID (manually entered),
      // trust it — store to DB without calling Xero
      if (cust.xeroContactId && UUID_RE.test(cust.xeroContactId)) {
        await prisma.customer.upsert({
          where: { id: custId },
          update: { xeroContactId: cust.xeroContactId, xeroSyncStatus: "Synced", syncErrorMessage: null, lastSyncAt: new Date() },
          create: {
            id: custId,
            name: cust.name,
            email: cust.email || null,
            phone: cust.phone || null,
            accountNumber: cust.accountNumber || null,
            xeroContactId: cust.xeroContactId,
            xeroSyncStatus: "Synced",
            lastSyncAt: new Date(),
          },
        }).catch(() => {});
        results.skipped++;
        continue;
      }

      if (!cust.name) {
        results.errors.push({ id: custId, name: "(no name)", error: "Skipped — item has no name" });
        continue;
      }

      try {
        const syncResult = await createXeroContact({
          name: cust.name,
          email: cust.email || undefined,
          phone: cust.phone || undefined,
          accountNumber: cust.accountNumber || undefined,
          address: cust.address || undefined,
          country: "USA",
        });

        const xeroContactId   = syncResult.contactId;
        const xeroAccountNumber = syncResult.accountNumber || cust.accountNumber;

        // Persist to DB
        await prisma.customer.upsert({
          where: { id: custId },
          update: {
            xeroContactId,
            accountNumber: xeroAccountNumber || undefined,
            xeroSyncStatus: "Synced",
            syncErrorMessage: null,
            lastSyncAt: new Date(),
          },
          create: {
            id: custId,
            name: cust.name,
            email: cust.email || null,
            phone: cust.phone || null,
            accountNumber: xeroAccountNumber || null,
            xeroContactId,
            xeroSyncStatus: "Synced",
            lastSyncAt: new Date(),
          },
        });

        // Write Xero Contact ID and status back to Monday board
        await updateCustomerXeroId(custId, xeroContactId).catch(() => {});
        await updateCustomerXeroStatus(custId, "Synced").catch(() => {});

        console.log(`[customers/sync-all] ✓ ${cust.name} → ${xeroContactId}`);
        results.synced++;
      } catch (err) {
        console.error(`[customers/sync-all] ✗ ${cust.name}:`, err.message);
        results.errors.push({ id: custId, name: cust.name, error: err.message });

        await prisma.customer.upsert({
          where: { id: custId },
          update: { xeroSyncStatus: "Failed", syncErrorMessage: err.message, lastSyncAt: new Date() },
          create: {
            id: custId,
            name: cust.name,
            email: cust.email || null,
            xeroSyncStatus: "Failed",
            syncErrorMessage: err.message,
            lastSyncAt: new Date(),
          },
        }).catch(() => {});

        await updateCustomerXeroStatus(custId, "Error").catch(() => {});
      }
    }

    console.log(`[customers/sync-all] Done — synced=${results.synced} skipped=${results.skipped} errors=${results.errors.length}`);
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
