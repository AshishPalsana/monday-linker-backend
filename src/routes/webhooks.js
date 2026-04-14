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
    const targetBoardId = String(BOARD.WORK_ORDERS);

    console.log(`[webhook] Target WO board ID: ${targetBoardId}`);
    console.log(`[webhook] Event board ID:     ${String(boardId)}`);
    console.log(`[webhook] Board match: ${String(boardId) === targetBoardId}`);

    if (String(boardId) !== targetBoardId) {
      console.log(`[webhook] Ignoring — event is for board ${boardId}, not the Work Orders board (${targetBoardId})`);
      return res.status(200).send("Ignored");
    }

    // 3. Generate next sequential WO ID
    console.log(`[webhook] Generating sequential ID for pulse ${pulseId}…`);
    const newWorkOrderId = await getNextSequentialId(targetBoardId);
    console.log(`[webhook] Generated ID: "${newWorkOrderId}" — writing to Monday item ${pulseId}`);

    // 4. Write ID back to Monday.com item
    await updateWorkOrderId(pulseId, newWorkOrderId);
    console.log(`[webhook] ✓ Successfully set Work Order ID "${newWorkOrderId}" on item ${pulseId}`);

    res.status(200).send("OK");
  } catch (error) {
    console.error("[webhook] ✗ Error processing Monday.com event:", error.message);
    console.error("[webhook] Stack:", error.stack);
    next(error);
  }
});

module.exports = router;
