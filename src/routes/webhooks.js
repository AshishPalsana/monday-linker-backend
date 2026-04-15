const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { getNextSequentialId } = require("../lib/idGenerator");
const { updateWorkOrderId, updateCustomerAccountNumber, BOARD, getLocationDetails, getWorkOrderDetails } = require("../lib/mondayClient");
const companyCam = require("../services/companyCamService");
const xeroService = require("../services/xeroService");


/**
 * Monday.com Webhook Endpoint
 * trigger: "When an item is created"
 */
router.post("/monday/item-created", async (req, res, next) => {
  try {
    console.log("[webhook] POST /monday/item-created — raw body:", JSON.stringify(req.body, null, 2));

    const { challenge, event } = req.body;

    // 1. Handle Monday.com challenge handshake
    if (challenge) {
      console.log("[webhook] Challenge handshake — responding with challenge token");
      return res.status(200).json({ challenge });
    }

    if (!event) {
      console.warn("[webhook] No event in body — nothing to process");
      return res.status(200).send("No event");
    }

    console.log(`[webhook] Event received — type=${event.type} boardId=${event.boardId} pulseId=${event.pulseId}`);

    // 2. Only handle item-created events
    if (event.type !== "create_pulse") {
      console.log(`[webhook] Ignoring event type "${event.type}" — only create_pulse is handled`);
      return res.status(200).send("Ignored");
    }

    const { pulseId, boardId } = event;
    const woBoardId = String(BOARD.WORK_ORDERS);
    const custBoardId = String(BOARD.CUSTOMERS);

    console.log(`[webhook] Event pulseId=${pulseId} boardId=${boardId}`);

    // Case 1: Work Order created
    if (String(boardId) === woBoardId) {
      console.log(`[webhook] Processing NEW WORK ORDER…`);

      // ── Step A: Assign sequential WO ID synchronously (must be fast — Monday times out at 5s)
      const newWorkOrderId = await getNextSequentialId(woBoardId, "WO-");
      await updateWorkOrderId(pulseId, newWorkOrderId);
      console.log(`[webhook] ✓ Work Order ID "${newWorkOrderId}" set on pulse ${pulseId}`);

      // ── Step B: Non-blocking post-processing (Xero + CompanyCam)
      setImmediate(async () => {
        // Fetch full WO details once for all downstream services
        let wo = null;
        try {
          wo = await getWorkOrderDetails(pulseId);
        } catch (err) {
          console.error("[webhook] Failed to fetch WO details:", err.message);
        }

        const workOrderName = wo?.name || newWorkOrderId;

        // ── Xero Project creation ──────────────────────────────────────────
        try {
          console.log(`[webhook] Xero: Creating project for ${newWorkOrderId}…`);
          const xeroProjectId = await xeroService.createXeroProject({
            workOrderId:   newWorkOrderId,
            workOrderName: workOrderName,
          });

          // Persist mapping so frontend can display the Xero Project link
          await prisma.workOrderSync.upsert({
            where:  { mondayItemId: String(pulseId) },
            update: { xeroProjectId, workOrderId: newWorkOrderId, syncError: null },
            create: {
              mondayItemId:  String(pulseId),
              workOrderId:   newWorkOrderId,
              xeroProjectId,
            },
          });

          console.log(`[webhook] ✓ Xero Project created — projectId: ${xeroProjectId}`);
        } catch (err) {
          console.error("[webhook] ✗ Xero Project creation failed:", err.message);

          // Record failure so admin can retry via POST /api/xero/retry-sync/:mondayItemId
          await prisma.workOrderSync.upsert({
            where:  { mondayItemId: String(pulseId) },
            update: { syncError: err.message, workOrderId: newWorkOrderId },
            create: {
              mondayItemId: String(pulseId),
              workOrderId:  newWorkOrderId,
              syncError:    err.message,
            },
          }).catch((dbErr) => {
            console.error("[webhook] Failed to persist Xero sync error to DB:", dbErr.message);
          });
        }

        // ── CompanyCam report creation ─────────────────────────────────────
        try {
          if (wo && wo.locationId) {
            console.log(`[webhook] CompanyCam: Triggering report for WO ${newWorkOrderId} at location ${wo.locationId}`);
            // await companyCam.createProjectReport(wo.companyCamProjectId, { title: newWorkOrderId });
          }
        } catch (err) {
          console.error("[webhook] CompanyCam report sync error:", err.message);
        }
      });

      return res.status(200).send("OK");
    }

    // Case 2: Customer created
    if (String(boardId) === custBoardId) {
      console.log(`[webhook] Processing NEW CUSTOMER…`);
      const newAccountNumber = await getNextSequentialId(custBoardId, "CUST-");
      await updateCustomerAccountNumber(pulseId, newAccountNumber);
      console.log(`[webhook] ✓ Successfully set Customer Account Number "${newAccountNumber}" on item ${pulseId}`);
      return res.status(200).send("OK");
    }

    // Case 3: Location created
    if (String(boardId) === String(BOARD.LOCATIONS)) {
      console.log(`[webhook] Processing NEW LOCATION…`);
      setImmediate(async () => {
        try {
          const loc = await getLocationDetails(pulseId);
          if (loc) {
            await companyCam.createProject({
              name: loc.name,
              address: loc.streetAddress,
              city: loc.city,
              state: loc.state,
              zip: loc.zip
            });
          }
        } catch (err) {
          console.error("[webhook] CompanyCam location sync error:", err.message);
        }
      });
      return res.status(200).send("OK");
    }


    // Default: Ignore other boards
    console.log(`[webhook] Ignoring — event is for board ${boardId}, not monitored for auto-ID`);
    return res.status(200).send("Ignored");
  } catch (error) {
    console.error("[webhook] ✗ Error processing Monday.com event:", error.message);
    console.error("[webhook] Stack:", error.stack);
    next(error);
  }
});

/**
 * Manual seed route to jumpstart the counter without waiting for a slow webhook
 */
router.get("/debug/seed-customers", async (req, res) => {
  try {
    const { getNextSequentialId } = require("../lib/idGenerator");
    const { BOARD } = require("../lib/mondayClient");
    
    console.log("[debug] Manual seeding for Customers board...");
    const nextId = await getNextSequentialId(BOARD.CUSTOMERS, "CUST-");
    
    res.json({ 
      status: "ok", 
      message: "Customer counter seeded successfully", 
      nextIdAvailable: nextId 
    });
  } catch (err) {
    console.error("[debug] Seeding failed:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});

/**
 * Reset route to force the counter back to a proper number (e.g. 1000)
 */
router.get("/debug/reset-customers", async (req, res) => {
  try {
    const prisma = require("../lib/prisma");
    const { BOARD } = require("../lib/mondayClient");
    const startFrom = parseInt(req.query.start) || 1000;
    
    await prisma.sequentialIdCounter.upsert({
      where: { boardId: BOARD.CUSTOMERS },
      update: { currentId: startFrom },
      create: { boardId: BOARD.CUSTOMERS, prefix: "CUST-", currentId: startFrom }
    });
    
    res.json({ 
      status: "ok", 
      message: `Customer counter reset to ${startFrom}. Next ID will be ${startFrom + 1}` 
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;
