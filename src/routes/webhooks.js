const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { getNextSequentialId } = require("../lib/idGenerator");
const {
  updateWorkOrderId,
  updateCustomerAccountNumber,
  updateCustomerXeroId,
  updateCustomerXeroStatus,
  BOARD,
  COL,
  getWorkOrderDetails,
  getCustomerDetails,
  graphql,
} = require("../lib/mondayClient");
const companyCam = require("../services/companyCamService");
const xeroService = require("../services/xeroService");
const { aggregateWorkOrderCosts } = require("../services/costAggregationService");

/**
 * Resolve (or create) a Xero Contact for a given Monday customer pulse.
 *
 * Strategy:
 *  1. If DB already has a xeroContactId → return it immediately (idempotent).
 *  2. Otherwise fetch customer details from Monday and call createXeroContact,
 *     which internally handles duplicate-name conflicts by finding the existing
 *     contact in Xero rather than failing.
 *  3. Persist the result to DB and write it back to the Monday board.
 *
 * Returns null (and logs a warning) if the customer cannot be resolved.
 */
async function resolveXeroContact(customerId) {
  const custId = String(customerId);

  // 1. Fast path — already synced
  const existing = await prisma.customer.findUnique({ where: { id: custId } });
  if (existing?.xeroContactId) {
    console.log(`[webhook] Customer ${custId} already synced → ContactID: ${existing.xeroContactId}`);
    return existing.xeroContactId;
  }

  // 2. Fetch details from Monday
  const cust = await getCustomerDetails(custId);
  if (!cust?.name) {
    console.warn(`[webhook] Customer ${custId} not found in Monday — cannot resolve Xero Contact`);
    return null;
  }

  // 3. Create/find in Xero (createXeroContact handles duplicate-name conflicts)
  let xeroContactId;
  try {
    xeroContactId = await xeroService.createXeroContact({
      name: cust.name,
      email: cust.email || undefined,
      phone: cust.phone || undefined,
      accountNumber: cust.accountNumber || undefined,
      // Prefer structured address fields from DB; fall back to Monday's combined string
      addressLine1: existing?.addressLine1 || cust.address || undefined,
      addressLine2: existing?.addressLine2 || undefined,
      city: existing?.city || undefined,
      state: existing?.state || undefined,
      zip: existing?.zip || undefined,
      country: existing?.country || "USA",
    });
  } catch (xeroErr) {
    console.error(`[webhook] Xero contact creation failed for customer ${custId}:`, xeroErr.message);

    // Mark Monday status as Error
    await updateCustomerXeroStatus(custId, "Error").catch(() => {});

    // Persist failure to DB
    await prisma.customer.upsert({
      where: { id: custId },
      update: {
        xeroSyncStatus: "Failed",
        syncErrorMessage: xeroErr.message,
        lastSyncAt: new Date(),
      },
      create: {
        id: custId,
        name: cust.name,
        email: cust.email || null,
        phone: cust.phone || null,
        xeroSyncStatus: "Failed",
        syncErrorMessage: xeroErr.message,
        lastSyncAt: new Date(),
      },
    }).catch((dbErr) => console.error("[webhook] DB persist of Xero error failed:", dbErr.message));

    return null;
  }

  // 4. Persist success to DB
  await prisma.customer.upsert({
    where: { id: custId },
    update: {
      xeroContactId,
      xeroSyncStatus: "Synced",
      syncErrorMessage: null,
      lastSyncAt: new Date(),
    },
    create: {
      id: custId,
      name: cust.name,
      email: cust.email || null,
      phone: cust.phone || null,
      xeroContactId,
      xeroSyncStatus: "Synced",
      lastSyncAt: new Date(),
    },
  }).catch((dbErr) => console.error("[webhook] DB persist of Xero success failed:", dbErr.message));

  // 5. Write back to Monday board (non-blocking — board display is secondary)
  await updateCustomerXeroId(custId, xeroContactId).catch((e) =>
    console.warn(`[webhook] Monday Xero-ID update failed for ${custId}:`, e.message)
  );
  await updateCustomerXeroStatus(custId, "Synced").catch((e) =>
    console.warn(`[webhook] Monday Xero-Status update failed for ${custId}:`, e.message)
  );

  console.log(`[webhook] ✓ Customer ${custId} "${cust.name}" → Xero ContactID: ${xeroContactId}`);
  return xeroContactId;
}

// ── Main webhook handler ────────────────────────────────────────────────────

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
      console.log(`[webhook] Ignoring event type "${event.type}"`);
      return res.status(200).send("Ignored");
    }

    const { pulseId, boardId } = event;
    const woBoardId = String(BOARD.WORK_ORDERS);
    const custBoardId = String(BOARD.CUSTOMERS);

    // ── Work Orders board ───────────────────────────────────────────────────
    if (String(boardId) === woBoardId) {
      if (event.type === "create_pulse") {
        console.log(`[webhook] Processing NEW WORK ORDER…`);

        // Assign sequential WO-ID synchronously so Monday reflects it immediately
        const newWorkOrderId = await getNextSequentialId(woBoardId, "WO-");
        await updateWorkOrderId(pulseId, newWorkOrderId);
        console.log(`[webhook] ✓ Work Order ID "${newWorkOrderId}" set on pulse ${pulseId}`);

        // Respond to Monday immediately — all heavy work runs in background
        res.status(200).send("OK");

        setImmediate(async () => {
          // Persist work order record
          try {
            await prisma.workOrder.upsert({
              where: { id: String(pulseId) },
              update: { workOrderId: newWorkOrderId },
              create: { id: String(pulseId), workOrderId: newWorkOrderId },
            });
          } catch (dbErr) {
            console.error("[webhook] Failed to upsert work order record:", dbErr.message);
          }

          // Fetch WO details to get linked customer & location
          let wo = null;
          try {
            wo = await getWorkOrderDetails(pulseId);
          } catch (err) {
            console.error("[webhook] Failed to fetch WO details:", err.message);
          }

          const workOrderName = wo?.name || newWorkOrderId;

          // ── Xero Project creation ─────────────────────────────────────────
          try {
            if (!wo?.customerId) {
              throw new Error(
                "No Customer linked to this Work Order. " +
                "Link a customer and use 'Retry Sync' on the Work Order to create the Xero Project."
              );
            }

            const xeroContactId = await resolveXeroContact(wo.customerId);

            if (!xeroContactId) {
              throw new Error(
                `Customer ${wo.customerId} could not be synced to Xero. ` +
                "Fix the customer sync first, then retry this Work Order."
              );
            }

            console.log(`[webhook] Creating Xero Project for ${newWorkOrderId}…`);
            const xeroProjectId = await xeroService.createXeroProject({
              workOrderId: newWorkOrderId,
              workOrderName,
              contactId: xeroContactId,
            });

            await prisma.workOrderSync.upsert({
              where: { mondayItemId: String(pulseId) },
              update: { xeroProjectId, workOrderId: newWorkOrderId, syncError: null },
              create: { mondayItemId: String(pulseId), workOrderId: newWorkOrderId, xeroProjectId },
            });

            console.log(`[webhook] ✓ Xero Project created — projectId: ${xeroProjectId}`);
          } catch (err) {
            console.error("[webhook] ✗ Xero Project creation failed:", err.message);

            await prisma.workOrderSync.upsert({
              where: { mondayItemId: String(pulseId) },
              update: { syncError: err.message, workOrderId: newWorkOrderId },
              create: { mondayItemId: String(pulseId), workOrderId: newWorkOrderId, syncError: err.message },
            }).catch((dbErr) => console.error("[webhook] Failed to persist Xero sync error:", dbErr.message));
          }

          // ── CompanyCam report ─────────────────────────────────────────────
          try {
            if (wo?.locationId) {
              const mapping = await prisma.locationSync.findUnique({
                where: { mondayItemId: String(wo.locationId) },
              });

              if (mapping?.companyCamProjectId) {
                await companyCam.createProjectReport(mapping.companyCamProjectId, { title: newWorkOrderId });
                console.log(`[webhook] ✓ CompanyCam report created for ${newWorkOrderId}`);
              } else {
                console.warn(`[webhook] No CompanyCam project mapping for location ${wo.locationId}`);
              }
            }
          } catch (err) {
            console.error("[webhook] CompanyCam report sync error:", err.message);
          }
        });

        return; // already sent res above
      }

      // Column change events
      if (event.type === "change_column_value") {
        const techColId = String(COL.WORK_ORDERS.TECHNICIAN);
        const custColId = String(COL.WORK_ORDERS.CUSTOMER);

        // ── Technician assignment ───────────────────────────────────────────
        if (event.columnId === techColId) {
          console.log(`[webhook] Technician assignment changed on pulse ${pulseId}`);

          let assignedIds = [];
          try {
            const parsedValue = typeof event.value === "string" ? JSON.parse(event.value) : event.value;
            const persons = parsedValue?.personsAndTeams || [];
            assignedIds = persons.map((p) => String(p.id));
          } catch (err) {
            console.warn(`[webhook] Failed to parse technician value for pulse ${pulseId}:`, err.message);
          }

          if (assignedIds.length > 0) {
            await prisma.workOrder.upsert({
              where: { id: String(pulseId) },
              update: { assignedTechnicianIds: assignedIds },
              create: { id: String(pulseId), assignedTechnicianIds: assignedIds },
            });
            console.log(`[webhook] ✓ Updated technician assignment for WO ${pulseId}:`, assignedIds);
          }
        }

        // ── Customer linked/changed — create Xero Project if not yet done ──
        if (event.columnId === custColId) {
          console.log(`[webhook] Customer column changed on WO pulse ${pulseId} — checking Xero Project status`);

          res.status(200).send("OK");

          setImmediate(async () => {
            try {
              // Skip if a Xero project already exists
              const existingSync = await prisma.workOrderSync.findUnique({
                where: { mondayItemId: String(pulseId) },
              });
              if (existingSync?.xeroProjectId) {
                console.log(`[webhook] WO ${pulseId} already has Xero Project ${existingSync.xeroProjectId} — skipping`);
                return;
              }

              // Fetch current WO state (customer should now be set)
              const wo = await getWorkOrderDetails(pulseId);
              if (!wo?.customerId) {
                console.log(`[webhook] WO ${pulseId} customer column cleared — nothing to do`);
                return;
              }

              const xeroContactId = await resolveXeroContact(wo.customerId);
              if (!xeroContactId) {
                throw new Error(
                  `Customer ${wo.customerId} could not be synced to Xero. ` +
                  "Fix the customer sync first, then retry this Work Order."
                );
              }

              const workOrderId = existingSync?.workOrderId || wo.workOrderId || String(pulseId);
              const workOrderName = wo.name || workOrderId;

              console.log(`[webhook] Creating Xero Project for WO ${pulseId} (triggered by customer link)…`);
              const xeroProjectId = await xeroService.createXeroProject({
                workOrderId,
                workOrderName,
                contactId: xeroContactId,
              });

              await prisma.workOrderSync.upsert({
                where: { mondayItemId: String(pulseId) },
                update: { xeroProjectId, workOrderId, syncError: null },
                create: { mondayItemId: String(pulseId), workOrderId, xeroProjectId },
              });

              console.log(`[webhook] ✓ Xero Project created for WO ${pulseId} — projectId: ${xeroProjectId}`);
            } catch (err) {
              console.error(`[webhook] ✗ Xero Project creation (on customer link) failed for WO ${pulseId}:`, err.message);

              await prisma.workOrderSync.upsert({
                where: { mondayItemId: String(pulseId) },
                update: { syncError: err.message },
                create: {
                  mondayItemId: String(pulseId),
                  workOrderId: String(pulseId),
                  syncError: err.message,
                },
              }).catch((dbErr) => console.error("[webhook] Failed to persist WO sync error:", dbErr.message));
            }
          });

          return; // res already sent
        }
      }

      return res.status(200).send("OK");
    }

    // ── Customers board ─────────────────────────────────────────────────────
    if (String(boardId) === custBoardId) {
      console.log(`[webhook] Processing NEW CUSTOMER…`);

      // Assign sequential CUST-ID synchronously
      const newAccountNumber = await getNextSequentialId(custBoardId, "CUST-");
      await updateCustomerAccountNumber(pulseId, newAccountNumber);
      console.log(`[webhook] ✓ Customer Account Number "${newAccountNumber}" set on item ${pulseId}`);

      // Respond to Monday immediately
      res.status(200).send("OK");

      // Sync to Xero in background
      setImmediate(async () => {
        try {
          // Fetch fresh details (account number is now set on Monday)
          const cust = await getCustomerDetails(String(pulseId));
          if (!cust?.name) {
            console.warn(`[webhook] Customer ${pulseId} has no name — skipping Xero sync`);
            return;
          }

          // Check if structured address is already in DB (from /api/customers/upsert)
          const dbRecord = await prisma.customer.findUnique({ where: { id: String(pulseId) } });

          const xeroContactId = await xeroService.createXeroContact({
            name: cust.name,
            email: cust.email || undefined,
            phone: cust.phone || undefined,
            accountNumber: newAccountNumber,
            addressLine1: dbRecord?.addressLine1 || cust.address || undefined,
            addressLine2: dbRecord?.addressLine2 || undefined,
            city: dbRecord?.city || undefined,
            state: dbRecord?.state || undefined,
            zip: dbRecord?.zip || undefined,
            country: dbRecord?.country || "USA",
          });

          // Persist to DB
          await prisma.customer.upsert({
            where: { id: String(pulseId) },
            update: {
              xeroContactId,
              xeroSyncStatus: "Synced",
              syncErrorMessage: null,
              lastSyncAt: new Date(),
            },
            create: {
              id: String(pulseId),
              name: cust.name,
              email: cust.email || null,
              phone: cust.phone || null,
              accountNumber: newAccountNumber,
              xeroContactId,
              xeroSyncStatus: "Synced",
              lastSyncAt: new Date(),
            },
          });

          // Write back to Monday board
          await updateCustomerXeroId(String(pulseId), xeroContactId).catch((e) =>
            console.warn(`[webhook] Monday Xero-ID update failed:`, e.message)
          );
          await updateCustomerXeroStatus(String(pulseId), "Synced").catch((e) =>
            console.warn(`[webhook] Monday Xero-Status update failed:`, e.message)
          );

          console.log(`[webhook] ✓ Customer "${cust.name}" → Xero ContactID: ${xeroContactId}`);
        } catch (err) {
          console.error("[webhook] ✗ Customer Xero sync failed:", err.message);

          // Persist failure
          await prisma.customer.upsert({
            where: { id: String(pulseId) },
            update: { xeroSyncStatus: "Failed", syncErrorMessage: err.message, lastSyncAt: new Date() },
            create: {
              id: String(pulseId),
              name: cust?.name || "Unknown",
              xeroSyncStatus: "Failed",
              syncErrorMessage: err.message,
              lastSyncAt: new Date(),
            },
          }).catch(() => {});

          await updateCustomerXeroStatus(String(pulseId), "Error").catch(() => {});
        }
      });

      return; // already sent res above
    }

    // ── Locations board ─────────────────────────────────────────────────────
    // ── Locations board ─────────────────────────────────────────────────────
    if (String(boardId) === String(BOARD.LOCATIONS)) {
      const locStatusCol = String(COL.LOCATIONS.STATUS);
      if (event.type === "change_column_value" && event.columnId !== locStatusCol) {
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

    // ── Master Costs board ──────────────────────────────────────────────────
    if (String(boardId) === String(BOARD.MASTER_COSTS)) {
      console.log(`[webhook] Processing Master Cost ${event.type === "create_pulse" ? "CREATE" : "UPDATE"}…`);
      
      res.status(200).send("OK");

      setImmediate(async () => {
        try {
          // 1. Fetch current Master Cost item to get its linked Work Order
          const result = await graphql(`
            query {
              items(ids: [${pulseId}]) {
                column_values(ids: ["${COL.MASTER_COSTS.WORK_ORDERS_REL}"]) {
                  value
                }
              }
            }
          `);

          const item = result.items?.[0];
          const relVal = item?.column_values?.[0]?.value;
          
          if (relVal) {
            const parsed = JSON.parse(relVal);
            const linkedIds = parsed.linkedPulseIds || parsed.item_ids || [];
            const workOrderId = linkedIds[0]?.linkedPulseId || linkedIds[0]?.id || linkedIds[0];
            
            if (workOrderId) {
              await aggregateWorkOrderCosts(String(workOrderId));
            } else {
              console.log(`[webhook] Master Cost ${pulseId} has no linked Work Order yet.`);
            }
          }
        } catch (err) {
          console.error("[webhook] Master Cost aggregation error:", err.message);
        }
      });
      return;
    }

    console.log(`[webhook] Ignoring — event is for unmonitored board ${boardId}`);
    return res.status(200).send("Ignored");
  } catch (error) {
    console.error("[webhook] ✗ Error processing Monday.com event:", error.message);
    console.error("[webhook] Stack:", error.stack);
    next(error);
  }
});

// ── Debug / Admin routes ────────────────────────────────────────────────────

router.get("/debug/seed-customers", async (req, res) => {
  try {
    const nextId = await getNextSequentialId(BOARD.CUSTOMERS, "CUST-");
    res.json({ status: "ok", message: "Customer counter seeded successfully", nextIdAvailable: nextId });
  } catch (err) {
    console.error("[debug] Seeding failed:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});

router.get("/debug/reset-customers", async (req, res) => {
  try {
    const startFrom = parseInt(req.query.start) || 1000;
    await prisma.sequentialIdCounter.upsert({
      where: { boardId: BOARD.CUSTOMERS },
      update: { currentId: startFrom },
      create: { boardId: BOARD.CUSTOMERS, prefix: "CUST-", currentId: startFrom },
    });
    res.json({ status: "ok", message: `Customer counter reset to ${startFrom}. Next ID will be CUST-${startFrom + 1}` });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;
