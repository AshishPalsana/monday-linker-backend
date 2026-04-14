const prisma = require("./prisma");
const { 
  getLatestWorkOrderIdFromBoard,
  getLatestCustomerAccountNumberFromBoard,
  BOARD
} = require("./mondayClient");

/**
 * Gets the next sequential ID for a given board.
 * Uses a database counter for concurrency safety.
 * If no counter exists, it seeds it from the Monday.com board.
 */
async function getNextSequentialId(boardId, prefix = "WO-") {
  console.log(`[idGenerator] getNextSequentialId called — boardId=${boardId} prefix="${prefix}"`);

  return await prisma.$transaction(async (tx) => {
    // ── Step 1: look up existing counter ──────────────────────────────────
    let counter = await tx.sequentialIdCounter.findUnique({
      where: { boardId },
    });
    console.log(
      `[idGenerator] DB counter lookup — ${counter ? `found (currentId=${counter.currentId})` : "NOT FOUND — will seed from Monday board"}`
    );

    if (!counter) {
      // ── Step 2: seed from Monday.com board ──────────────────────────────
      console.log(`[idGenerator] Fetching latest ID from Monday.com board ${boardId}…`);
      let latestFromBoard;
      try {
        if (String(boardId) === String(BOARD.WORK_ORDERS)) {
          latestFromBoard = await getLatestWorkOrderIdFromBoard();
        } else if (String(boardId) === String(BOARD.CUSTOMERS)) {
          latestFromBoard = await getLatestCustomerAccountNumberFromBoard();
        } else {
          console.warn(`[idGenerator] Unknown boardId ${boardId} for seeding — defaulting to 0`);
          latestFromBoard = 0;
        }
        console.log(`[idGenerator] Monday board returned latestId=${latestFromBoard}`);
      } catch (err) {
        console.error(`[idGenerator] Failed to fetch latest ID from Monday board:`, err.message);
        latestFromBoard = 0;
      }

      const startId = Math.max(latestFromBoard, 1000);
      console.log(`[idGenerator] Seeding counter — latestFromBoard=${latestFromBoard}, startId=${startId}`);

      counter = await tx.sequentialIdCounter.create({
        data: { boardId, prefix, currentId: startId },
      });
      console.log(`[idGenerator] Counter created — currentId=${counter.currentId}`);
    }

    // ── Step 3: atomic increment ───────────────────────────────────────────
    console.log(`[idGenerator] Incrementing counter from ${counter.currentId}…`);
    const updatedCounter = await tx.sequentialIdCounter.update({
      where: { boardId },
      data: { currentId: { increment: 1 } },
    });

    const newIdValue = updatedCounter.currentId;
    const generatedId = `${prefix}${newIdValue}`;
    console.log(`[idGenerator] ✓ Generated ID: "${generatedId}" (newIdValue=${newIdValue})`);
    return generatedId;
  });
}

module.exports = {
  getNextSequentialId,
};
