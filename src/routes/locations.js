const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { body } = require("express-validator");
const { createLocationItem, updateLocationItem } = require("../lib/mondayClient");
const { syncLocation } = require("../services/companyCamService");

// router.use(requireAuth);

/**
 * GET /api/locations
 * Fetches all locations from Monday.com.
 */
router.get("/", async (req, res, next) => {
  try {
    const { getLocationsBoardData } = require("../lib/mondayClient");
    const prisma = require("../lib/prisma");

    // 1. Fetch full board structure from Monday
    const board = await getLocationsBoardData();
    if (!board) throw new Error("Could not fetch locations board data");

    // 2. Fetch mapping metadata
    const syncs = await prisma.locationSync.findMany();
    const syncMap = new Map(syncs.map(s => [s.mondayItemId, s.companyCamProjectId]));

    // 3. Inject CC project ID into items
    if (board.items_page?.items) {
      board.items_page.items = board.items_page.items.map(item => ({
        ...item,
        companyCamProjectId: syncMap.get(String(item.id)) || null
      }));
    }

    res.json({ success: true, data: board });
  } catch (err) {
    console.error("[api/locations] Fetch failed:", err);
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

/**
 * POST /api/locations
 * Creates a new location in Monday.com AND syncs it to CompanyCam.
 */
router.post("/",
  [
    body("name").isString().trim().notEmpty().withMessage("Location Name is required"),
    body("streetAddress").optional({ values: "falsy" }).isString().trim(),
    body("city").optional({ values: "falsy" }).isString().trim(),
    body("state").optional({ values: "falsy" }).isString().trim(),
    body("zip").optional({ values: "falsy" }).isString().trim(),
    body("locationStatus").optional({ values: "falsy" }).isString().trim(),
    body("notes").optional({ values: "falsy" }).isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      console.log("[api/locations] Create location request:", req.body.name);
      
      // 1. Create in Monday.com
      const createdItem = await createLocationItem(req.body);
      const pulseId = createdItem.id;

      console.log(`[api/locations] ✓ Monday item created: ${pulseId}. Triggering CompanyCam sync...`);

      // 2. Sync to CompanyCam (non-blocking for the response, but we trigger immediately)
      // Note: We use setImmediate to ensure the response is fast, 
      // but the sync happens right away.
      setImmediate(async () => {
        try {
          await syncLocation(pulseId, req.body);
        } catch (err) {
          console.error(`[api/locations] Background sync failed for ${pulseId}:`, err.message);
        }
      });

      res.status(201).json({
        success: true,
        data: {
          id: pulseId,
          name: createdItem.name
        }
      });
    } catch (err) {
      console.error("[api/locations] Create failed:", err);
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }
);

/**
 * PATCH /api/locations/:id
 * Updates an existing location in Monday.com and triggers a re-sync.
 */
router.patch("/:id",
  [
    body("name").optional().isString().trim().notEmpty(),
    body("streetAddress").optional().isString().trim(),
    body("city").optional().isString().trim(),
    body("state").optional().isString().trim(),
    body("zip").optional().isString().trim(),
    body("locationStatus").optional().isString().trim(),
    body("notes").optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    const pulseId = req.params.id;
    try {
      console.log(`[api/locations] Update request for pulse ${pulseId}`);
      
      await updateLocationItem(pulseId, req.body);
      
      // Trigger re-sync in background
      setImmediate(() => syncLocation(pulseId).catch(() => {}));

      res.json({ success: true, message: "Location updated and sync triggered." });
    } catch (err) {
      console.error(`[api/locations] Update failed for ${pulseId}:`, err);
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  }
);

module.exports = router;
