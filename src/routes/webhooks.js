const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { getNextSequentialId } = require("../lib/idGenerator");
const { updateWorkOrderId, updateCustomerAccountNumber, BOARD, getLocationDetails, getWorkOrderDetails } = require("../lib/mondayClient");
const companyCam = require("../services/companyCamService");
const xeroService = require("../services/xeroService");

router.post("/monday/item-created", async (req, res, next) => {
  try {
    console.log("[webhook] POST /monday/item-created — raw body:", JSON.stringify(req.body, null, 2));

    const { challenge, event } = req.body;

    if (challenge) {
      console.log("[webhook] Challenge handshake — responding with challenge token");
      return res.status(200).json({ challenge });
    }

    if (!event) {
      console.warn("[webhook] No event in body — nothing to process");
      return res.status(200).send("No event");
    }

    console.log(`[webhook] Event received — type=${event.type} boardId=${event.boardId} pulseId=${event.pulseId}`);

    if (event.type !== "create_pulse" && event.type !== "change_column_value") {
      console.log(`[webhook] Ignoring event type "${event.type}" — only create_pulse and change_column_value are handled`);
      return res.status(200).send("Ignored");
    }

    const { pulseId, boardId } = event;
    const woBoardId = String(BOARD.WORK_ORDERS);
    const custBoardId = String(BOARD.CUSTOMERS);

    console.log(`[webhook] Event pulseId=${pulseId} boardId=${boardId}`);

    if (String(boardId) === woBoardId) {
      console.log(`[webhook] Processing NEW WORK ORDER…`);

      const newWorkOrderId = await getNextSequentialId(woBoardId, "WO-");
      await updateWorkOrderId(pulseId, newWorkOrderId);
      console.log(`[webhook] ✓ Work Order ID "${newWorkOrderId}" set on pulse ${pulseId}`);

      setImmediate(async () => {
        let wo = null;
        try {
          wo = await getWorkOrderDetails(pulseId);
        } catch (err) {
          console.error("[webhook] Failed to fetch WO details:", err.message);
        }

        const workOrderName = wo?.name || newWorkOrderId;

        try {
          await prisma.workOrder.upsert({
            where: { id: String(pulseId) },
            update: { workOrderId: newWorkOrderId },
            create: { id: String(pulseId), workOrderId: newWorkOrderId },
          });

          console.log(`[webhook] Xero: Creating project for ${newWorkOrderId}…`);
          const xeroProjectId = await xeroService.createXeroProject({
            workOrderId: newWorkOrderId,
            workOrderName: workOrderName,
          });

          await prisma.workOrderSync.upsert({
            where: { mondayItemId: String(pulseId) },
            update: { xeroProjectId, workOrderId: newWorkOrderId, syncError: null },
            create: {
              mondayItemId: String(pulseId),
              workOrderId: newWorkOrderId,
              xeroProjectId,
            },
          });

          console.log(`[webhook] ✓ Xero Project created — projectId: ${xeroProjectId}`);
        } catch (err) {
          console.error("[webhook] ✗ Xero Project creation failed:", err.message);

          await prisma.workOrderSync.upsert({
            where: { mondayItemId: String(pulseId) },
            update: { syncError: err.message, workOrderId: newWorkOrderId },
            create: {
              mondayItemId: String(pulseId),
              workOrderId: newWorkOrderId,
              syncError: err.message,
            },
          }).catch((dbErr) => {
            console.error("[webhook] Failed to persist Xero sync error to DB:", dbErr.message);
          });
        }

        try {
          if (wo && wo.locationId) {
            console.log(`[webhook] CompanyCam: Triggering report for WO ${newWorkOrderId} at location ${wo.locationId}`);
            
            // Find the mapped CompanyCam Project ID
            const mapping = await prisma.locationSync.findUnique({
              where: { mondayItemId: String(wo.locationId) }
            });

            if (mapping && mapping.companyCamProjectId) {
              await companyCam.createProjectReport(mapping.companyCamProjectId, {
                title: newWorkOrderId
              });
              console.log(`[webhook] ✓ CompanyCam report created for ${newWorkOrderId}`);
            } else {
              console.warn(`[webhook] CompanyCam: No project mapping found for location ${wo.locationId}. Skipping report.`);
            }
          }
        } catch (err) {
          console.error("[webhook] CompanyCam report sync error:", err.message);
        }
      });

      return res.status(200).send("OK");
    }

    if (String(boardId) === custBoardId) {
      console.log(`[webhook] Processing NEW CUSTOMER…`);

      const newAccountNumber = await getNextSequentialId(custBoardId, "CUST-");
      await updateCustomerAccountNumber(pulseId, newAccountNumber);
      console.log(`[webhook] ✓ Successfully set Customer Account Number "${newAccountNumber}" on item ${pulseId}`);

      // 2. Sync to Xero as a Contact (non-blocking)
      setImmediate(async () => {
        try {
          const { getCustomerDetails } = require("../lib/mondayClient");
          const cust = await getCustomerDetails(pulseId);

          if (cust) {
            // Check if we have structured data in our DB (Source of Truth)
            const structured = await prisma.customer.findUnique({
              where: { id: String(pulseId) }
            });

            console.log(`[webhook] Xero: Syncing customer "${cust.name}" (${newAccountNumber})…`);

            await xeroService.createXeroContact({
              name: cust.name,
              email: cust.email,
              phone: cust.phone,
              // Structured fields from DB (if available)
              addressLine1: structured?.addressLine1,
              addressLine2: structured?.addressLine2,
              city: structured?.city,
              state: structured?.state,
              zip: structured?.zip,
              country: structured?.country,
              // Fallback to Monday's combined string
              address: structured ? undefined : cust.address,
              accountNumber: newAccountNumber,
            });
            console.log(`[webhook] ✓ Xero Contact synced for customer ${pulseId}`);

            // Link back Xero ID if created
            // TODO: Update pulse with xeroContactId if returned
          }
        } catch (err) {
          console.error("[webhook] ✗ Xero Contact sync failed:", err.message);
        }
      });

      return res.status(200).send("OK");
    }

    if (String(boardId) === String(BOARD.LOCATIONS)) {
      // For create_pulse, always sync. 
      // For change_column_value, only sync if the status column changed.
      const locStatusCol = String(COL.LOCATIONS.STATUS);
      if (event.type === "change_column_value" && event.columnId !== locStatusCol) {
        console.log(`[webhook] Ignoring change to column ${event.columnId} on Locations board (only tracking ${locStatusCol})`);
        return res.status(200).send("Ignored");
      }

      console.log(`[webhook] Processing ${event.type === "create_pulse" ? "NEW" : "UPDATED"} LOCATION…`);
      setImmediate(async () => {
        try {
          await companyCam.syncLocation(pulseId);
        } catch (err) {
          console.error("[webhook] CompanyCam location sync error:", err.message);
        }
      });
      return res.status(200).send("OK");
    }


    console.log(`[webhook] Ignoring — event is for board ${boardId}, not monitored for auto-ID`);
    return res.status(200).send("Ignored");
  } catch (error) {
    console.error("[webhook] ✗ Error processing Monday.com event:", error.message);
    console.error("[webhook] Stack:", error.stack);
    next(error);
  }
});

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
