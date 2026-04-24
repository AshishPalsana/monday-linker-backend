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
  getMasterCostItem,
  updateMasterCostItem,
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
  let finalAccountNumber;
  try {
    const syncResult = await xeroService.createXeroContact({
      name: cust.name,
      email: cust.email || undefined,
      phone: cust.phone || undefined,
      accountNumber: cust.accountNumber || undefined,
      addressLine1: existing?.addressLine1 || cust.address || undefined,
      addressLine2: existing?.addressLine2 || undefined,
      city: existing?.city || undefined,
      state: existing?.state || undefined,
      zip: existing?.zip || undefined,
      country: existing?.country || "USA",
    });
    xeroContactId = syncResult.contactId;
    finalAccountNumber = syncResult.accountNumber || cust.accountNumber;
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
      accountNumber: finalAccountNumber || undefined,
      xeroSyncStatus: "Synced",
      syncErrorMessage: null,
      lastSyncAt: new Date(),
    },
    create: {
      id: custId,
      name: cust.name,
      email: cust.email || null,
      phone: cust.phone || null,
      accountNumber: finalAccountNumber || null,
      xeroContactId,
      xeroSyncStatus: "Synced",
      lastSyncAt: new Date(),
    },
  }).catch((dbErr) => console.error("[webhook] DB persist of Xero success failed:", dbErr.message));

  // 5. Update Monday Account Number if it changed (e.g. pulled from existing Xero contact)
  if (finalAccountNumber && finalAccountNumber !== cust.accountNumber) {
    await updateCustomerAccountNumber(custId, finalAccountNumber).catch(() => {});
  }

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

    const ALLOWED_TYPES = ["create_pulse", "change_column_value", "update_column_value", "change_name"];
    if (!ALLOWED_TYPES.includes(event.type)) {
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
      // ── New customer created ──
      if (event.type === "create_pulse") {
        console.log(`[webhook] Processing NEW CUSTOMER…`);

        // Assign sequential CUST-ID synchronously
        const newAccountNumber = await getNextSequentialId(custBoardId, "CUST-");
        await updateCustomerAccountNumber(pulseId, newAccountNumber);
        console.log(`[webhook] ✓ Customer Account Number "${newAccountNumber}" set on item ${pulseId}`);

        // Respond to Monday immediately
        res.status(200).send("OK");

        // Sync to Xero in background
        setImmediate(async () => {
          let cust = null;
          try {
            // Fetch fresh details (account number is now set on Monday)
            cust = await getCustomerDetails(String(pulseId));
            if (!cust?.name) {
              console.warn(`[webhook] Customer ${pulseId} has no name — skipping Xero sync`);
              return;
            }

            // Check if structured address is already in DB (from /api/customers/upsert)
            const dbRecord = await prisma.customer.findUnique({ where: { id: String(pulseId) } });

            const syncResult = await xeroService.createXeroContact({
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

            const xeroContactId = syncResult.contactId;
            const finalAccountNumber = syncResult.accountNumber || newAccountNumber;

            // Persist to DB
            await prisma.customer.upsert({
              where: { id: String(pulseId) },
              update: {
                xeroContactId,
                accountNumber: finalAccountNumber,
                xeroSyncStatus: "Synced",
                syncErrorMessage: null,
                lastSyncAt: new Date(),
              },
              create: {
                id: String(pulseId),
                name: cust.name,
                email: cust.email || null,
                phone: cust.phone || null,
                accountNumber: finalAccountNumber,
                xeroContactId,
                xeroSyncStatus: "Synced",
                lastSyncAt: new Date(),
              },
            });

            // Write back to Monday if account number changed (e.g. pulled from Xero)
            if (finalAccountNumber !== newAccountNumber) {
              await updateCustomerAccountNumber(String(pulseId), finalAccountNumber).catch(() => {});
            }

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

      // ── Customer details changed — sync updates to Xero ──
      if (event.type === "change_column_value" || event.type === "update_column_value" || event.type === "change_name") {
        const SKIP_COLS = new Set([
          String(COL.CUSTOMERS.XERO_CONTACT_ID),
          String(COL.CUSTOMERS.XERO_SYNC_STATUS),
          String(COL.CUSTOMERS.ACCOUNT_NUMBER),
          String(COL.CUSTOMERS.CUSTOMER_STATUS), // Monday-only field, no Xero equivalent
        ]);

        // Manual retry trigger: changing XERO_SYNC_STATUS re-runs the full sync
        if (event.type === "change_column_value" && event.columnId === String(COL.CUSTOMERS.XERO_SYNC_STATUS)) {
          console.log(`[webhook] Manual Xero sync triggered for customer ${pulseId}`);
          res.status(200).send("OK");
          setImmediate(async () => {
            try {
              await resolveXeroContact(pulseId);
              console.log(`[webhook] ✓ Manual sync completed for customer ${pulseId}`);
            } catch (err) {
              console.error(`[webhook] ✗ Manual sync failed for customer ${pulseId}:`, err.message);
            }
          });
          return;
        }

        // Skip other system-written columns to avoid infinite loops
        // Covers both change_column_value AND update_column_value so backend write-backs
        // (Account Number, Xero Contact ID, Xero Sync Status) don't re-trigger a sync.
        if (SKIP_COLS.has(event.columnId)) {
          return res.status(200).send("Ignored");
        }

        console.log(`[webhook] Customer ${pulseId} changed (${event.type}${event.columnId ? ` col=${event.columnId}` : ""}) — updating Xero…`);
        res.status(200).send("OK");

        setImmediate(async () => {
          try {
            const dbRecord = await prisma.customer.findUnique({ where: { id: String(pulseId) } });
            if (!dbRecord?.xeroContactId) {
              console.log(`[webhook] Customer ${pulseId} not yet synced to Xero — skipping update`);
              return;
            }

            const cust = await getCustomerDetails(String(pulseId));
            if (!cust?.name) return;

            await xeroService.createXeroContact({
              name: cust.name,
              email: cust.email || undefined,
              phone: cust.phone || undefined,
              accountNumber: dbRecord.accountNumber || cust.accountNumber || undefined,
              addressLine1: dbRecord.addressLine1 || cust.address || undefined,
              addressLine2: dbRecord.addressLine2 || undefined,
              city: dbRecord.city || undefined,
              state: dbRecord.state || undefined,
              zip: dbRecord.zip || undefined,
              country: dbRecord.country || "USA",
              xeroContactId: dbRecord.xeroContactId,
            });

            console.log(`[webhook] ✓ Customer ${pulseId} updated in Xero`);
          } catch (err) {
            console.error(`[webhook] ✗ Customer Xero update failed for ${pulseId}:`, err.message);
          }
        });
        return;
      }

      return res.status(200).send("OK");
    }

    // ── Locations board ─────────────────────────────────────────────────────
    if (String(boardId) === String(BOARD.LOCATIONS)) {
      const isCreate = event.type === "create_pulse";
      const isNameChange = event.type === "change_name";
      const isColumnChange = event.type === "change_column_value" || event.type === "update_column_value";

      if (!isCreate && !isNameChange && !isColumnChange) {
        return res.status(200).send("Ignored");
      }

      console.log(`[webhook] Processing ${isCreate ? "NEW" : "UPDATED"} LOCATION (${event.type}${isColumnChange ? ` col=${event.columnId}` : ""})…`);
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
      // XERO_SYNC_ID and INVOICE_STATUS are excluded — written by our own backend;
      // processing them would cause infinite loops.
      const COST_RELEVANT_COLS = new Set([
        COL.MASTER_COSTS.TYPE,
        COL.MASTER_COSTS.QUANTITY,
        COL.MASTER_COSTS.RATE,
        COL.MASTER_COSTS.DESCRIPTION,
        COL.MASTER_COSTS.DATE,
        COL.MASTER_COSTS.TOTAL_COST,
        COL.MASTER_COSTS.WORK_ORDERS_REL,
      ]);

      const isCreate     = event.type === "create_pulse";
      const isNameChange = event.type === "change_name";
      const isCostRelevantChange = !isCreate && !isNameChange && COST_RELEVANT_COLS.has(event.columnId);

      if (!isCreate && !isNameChange && !isCostRelevantChange) {
        console.log(`[webhook] Master Cost column "${event.columnId}" is not cost-relevant — skipping.`);
        return res.status(200).send("Ignored");
      }

      console.log(`[webhook] Processing Master Cost ${isCreate ? "CREATE" : isNameChange ? "NAME CHANGE" : `UPDATE (col=${event.columnId})`}…`);

      res.status(200).send("OK");

      setImmediate(async () => {
        try {
          // Fetch the full item — needed for both aggregation and Xero sync
          const item = await getMasterCostItem(String(pulseId));
          if (!item) {
            console.warn(`[webhook] Master Cost ${pulseId} not found — skipping`);
            return;
          }

          const MC  = COL.MASTER_COSTS;
          const col = (id) => item.column_values.find((c) => c.id === id);

          // Resolve linked Work Order ID
          const relCol    = col(MC.WORK_ORDERS_REL);
          let workOrderId = null;
          if (Array.isArray(relCol?.linked_item_ids) && relCol.linked_item_ids.length > 0) {
            workOrderId = relCol.linked_item_ids[0];
          } else if (relCol?.value) {
            try {
              const parsed   = JSON.parse(relCol.value);
              const linkedIds = parsed.linkedPulseIds || parsed.item_ids || [];
              workOrderId    = linkedIds[0]?.linkedPulseId || linkedIds[0]?.id || linkedIds[0];
            } catch (_) {}
          }

          // 1. Aggregate total cost on the Work Order
          if (workOrderId) {
            await aggregateWorkOrderCosts(String(workOrderId));
          } else {
            console.log(`[webhook] Master Cost ${pulseId} has no linked Work Order yet — skipping aggregation.`);
          }

          // 2. Xero sync — only for edits made directly in Monday (creates are handled by the POST route)
          if (!isCreate && workOrderId) {
            const woSync = await prisma.workOrderSync.findUnique({
              where: { mondayItemId: String(workOrderId) },
            });
            if (!woSync?.xeroProjectId) {
              console.log(`[webhook] WO ${workOrderId} has no Xero Project — skipping Xero sync`);
              return;
            }

            let existingXeroSyncId   = col(MC.XERO_SYNC_ID)?.text?.trim() || null;
            const type               = col(MC.TYPE)?.text || null;
            const quantity           = parseFloat(col(MC.QUANTITY)?.text || 0);
            const rate               = parseFloat(col(MC.RATE)?.text || 0);
            const totalCost          = parseFloat(col(MC.TOTAL_COST)?.text || 0);
            const description        = col(MC.DESCRIPTION)?.text || null;
            const date               = col(MC.DATE)?.text || null;

            // Skip if the item has no type or zero cost — it's not fully set up yet
            if (!type || (totalCost === 0 && rate === 0)) {
              console.log(`[webhook] Master Cost ${pulseId} has no type or zero cost — skipping Xero sync`);
              return;
            }

            const lockAcquired = xeroService.tryAcquireSyncLock(String(pulseId));
            if (!lockAcquired) {
              console.log(`[webhook] Sync lock held for item ${pulseId} — skipping duplicate Xero sync`);
              return;
            }

            try {
              // Re-fetch the live item after acquiring the lock to capture two race conditions:
              //  1. Concurrent sync wrote xeroSyncId between snapshot and now (use UPDATE path)
              //  2. Item was renamed while this webhook waited for the lock (use new name)
              let liveName = item.name;
              const liveItem = await getMasterCostItem(String(pulseId)).catch(() => null);
              if (liveItem) {
                if (!existingXeroSyncId) {
                  const liveXeroId = liveItem.column_values?.find(c => c.id === MC.XERO_SYNC_ID)?.text?.trim() || null;
                  if (liveXeroId) {
                    console.log(`[webhook] Item ${pulseId} synced concurrently — switching to update path (xeroSyncId=${liveXeroId})`);
                    existingXeroSyncId = liveXeroId;
                  }
                }
                if (liveItem.name && liveItem.name !== item.name) {
                  console.log(`[webhook] Item ${pulseId} name updated since snapshot: "${item.name}" → "${liveItem.name}"`);
                }
                liveName = liveItem.name || item.name;
              }

              const newXeroSyncId = await xeroService.syncMasterCostItemToXero({
                xeroProjectId: woSync.xeroProjectId,
                existingXeroSyncId,
                type,
                description: liveName || description,
                quantity,
                rate,
                totalCost,
                date,
              });

              if (newXeroSyncId !== null && newXeroSyncId !== existingXeroSyncId) {
                await updateMasterCostItem(String(pulseId), { xeroSyncId: newXeroSyncId }).catch((err) => {
                  console.warn(`[webhook] Could not write xeroSyncId back to Monday item ${pulseId}:`, err.message);
                });
              }
              console.log(`[webhook] ✓ Xero sync for Master Cost ${pulseId} — xeroSyncId=${newXeroSyncId}`);
            } catch (xeroErr) {
              console.warn(`[webhook] Xero sync failed for Master Cost ${pulseId} (non-fatal):`, xeroErr.message);
            } finally {
              xeroService.releaseSyncLock(String(pulseId));
            }
          }
        } catch (err) {
          console.error("[webhook] Master Cost processing error:", err.message);
        }
      });
      return;
    }

    // ── Invoice Line Items board ──────────────────────────────────────────────
    if (String(boardId) === String(BOARD.INVOICE_ITEMS)) {
      // Only care about new items — column changes are not actionable here
      if (event.type !== "create_pulse") {
        return res.status(200).send("Ignored");
      }

      console.log(`[webhook] Invoice Line Item created — pulse ${pulseId}`);
      res.status(200).send("OK");

      setImmediate(async () => {
        // Grace period: if this item was created by our billing route, the Xero invoice ID
        // will be written back within a few seconds. Wait 10s then check.
        // Items still missing the ID after this window were created manually in Monday.
        await new Promise((r) => setTimeout(r, 10000));

        try {
          const result = await graphql(`
            query {
              items(ids: [${pulseId}]) {
                name
                column_values(ids: [
                  "${COL.INVOICE_ITEMS.INVOICE_ID}",
                  "${COL.INVOICE_ITEMS.BILLING_STATUS}",
                  "${COL.INVOICE_ITEMS.WORK_ORDERS_REL}"
                ]) {
                  id text value
                  ... on BoardRelationValue { linked_item_ids }
                }
              }
            }
          `);

          const item = result?.items?.[0];
          if (!item) {
            console.warn(`[webhook] Invoice Item ${pulseId} not found after grace period`);
            return;
          }

          const xeroInvoiceId = item.column_values.find(
            (c) => c.id === COL.INVOICE_ITEMS.INVOICE_ID
          )?.text?.trim();

          if (xeroInvoiceId) {
            // Billing route already handled this item — Xero invoice ID is written back
            console.log(`[webhook] ✓ Invoice Item ${pulseId} ("${item.name}") — Xero invoice ${xeroInvoiceId} confirmed`);
            return;
          }

          // No Xero invoice ID after grace period — item was created directly in Monday,
          // not via the Prepare Invoice flow. Log clearly so the admin knows to act.
          const relCol = item.column_values.find((c) => c.id === COL.INVOICE_ITEMS.WORK_ORDERS_REL);
          const linkedWoId = relCol?.linked_item_ids?.[0] || null;

          console.warn(
            `[webhook] ⚠ Invoice Line Item ${pulseId} ("${item.name}") was created directly in Monday ` +
            `(no Xero invoice ID). Work Order: ${linkedWoId || "not linked"}. ` +
            `Use the Prepare Invoice button in the app to properly sync this to Xero.`
          );
        } catch (err) {
          console.error(`[webhook] Invoice Item grace-period check failed for pulse ${pulseId}:`, err.message);
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
