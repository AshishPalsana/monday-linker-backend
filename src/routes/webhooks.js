const express = require("express");
const router = express.Router();
const { getNextSequentialId } = require("../lib/idGenerator");
const { updateWorkOrderId, BOARD } = require("../lib/mondayClient");

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
      const newWorkOrderId = await getNextSequentialId(woBoardId, "WO-");
      await updateWorkOrderId(pulseId, newWorkOrderId);
      console.log(`[webhook] ✓ Successfully set Work Order ID "${newWorkOrderId}" on item ${pulseId}`);
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

    // Default: Ignore other boards
    console.log(`[webhook] Ignoring — event is for board ${boardId}, not monitored for auto-ID`);
    return res.status(200).send("Ignored");
  } catch (error) {
    console.error("[webhook] ✗ Error processing Monday.com event:", error.message);
    console.error("[webhook] Stack:", error.stack);
    next(error);
  }
});

module.exports = router;
