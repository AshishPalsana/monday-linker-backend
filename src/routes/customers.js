const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { combineAddress } = require("../utils/addressUtils");
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { body } = require("express-validator");

router.use(requireAuth);

const { syncCustomerToXero } = require("../services/customerSyncService");
const { combineAddress } = require("../utils/addressUtils");
const { updateCustomerBillingDetails, updateCustomerXeroStatus } = require("../lib/mondayClient");

router.use(requireAuth);

/**
 * Hardened Upsert:
 * 1. Validates required fields (Name, Addr1, City, Country).
 * 2. Saves to DB (Atomic versioning).
 * 3. Triggers background Xero sync if data changed or retry requested.
 */
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

      // 1. Fetch existing to detect changes
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

      console.log(`[api/customers] Upser pulse ${pulseId} — hasChanged=${hasChanged} shouldSync=${shouldSync}`);

      // 2. Perform DB Update (Source of Truth)
      // Increment syncVersion if we are about to trigger a new sync
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

      // 3. Update Monday with business fields (Non-blocking)
      setImmediate(async () => {
        try {
          await updateCustomerBillingDetails(pulseId, billingAddressStr, billingTerms);
          if (shouldSync) {
            await updateCustomerXeroStatus(pulseId, "Pending");
            // 4. Trigger Orchestrator
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

/**
 * Manual Retry endpoint
 */
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

module.exports = router;
