const prisma = require("../../lib/prisma");
const monday = require("../../lib/mondayClient");
const { getCSTOffset } = require("../../lib/cstTime");

function toCSTDateString(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(date);
}

/**
 * Syncs a Time Entry to the Master Costs board.
 * One Time Entry = Exactly One Master Cost (Labor or Travel).
 */
async function syncTimeEntryToCost(timeEntryId) {
  try {
    const entry = await prisma.timeEntry.findUnique({
      where: { id: timeEntryId },
      include: { technician: true },
    });

    if (!entry || entry.status === "Open" || !entry.clockOut) {
      console.log(`[syncService] TimeEntry ${timeEntryId} is still open or missing. Skipping sync.`);
      return;
    }

    if (entry.entryType === "DailyShift") {
      console.log(`[syncService] DailyShift TimeEntry ${timeEntryId} — no cost sync needed.`);
      return;
    }

    if (!entry.workOrderRef) {
      console.log(`[syncService] TimeEntry ${timeEntryId} has no Work Order. Skipping cost sync.`);
      return;
    }

    const type = "Labor";
    const quantity = parseFloat(entry.hoursWorked || 0);
    const rate = parseFloat(entry.technician.burdenRate || 0);
    const totalCost = quantity * rate;
    const date = toCSTDateString(entry.clockOut);
    const description = `${entry.entryType}: ${quantity}h by ${entry.technician.name}`;

    // Use the stored Technicians board item ID (set on login) for the board_relation column.
    // Fall back to a live lookup if not yet stored (e.g. technician hasn't re-logged in since migration).
    let technicianBoardItemId = entry.technician?.mondayItemId ?? null;
    if (!technicianBoardItemId && entry.technician?.email) {
      try {
        const techItem = await monday.getTechnicianByEmail(entry.technician.email);
        technicianBoardItemId = techItem?.mondayItemId ?? null;
      } catch (_) { /* non-fatal */ }
    }

    if (entry.masterCostItemId) {
      // Update existing
      console.log(`[syncService] Updating existing Master Cost ${entry.masterCostItemId} for TimeEntry ${timeEntryId}`);
      await monday.updateMasterCostItem(entry.masterCostItemId, {
        name: `Labor: ${entry.technician.name}`,
        quantity,
        rate,
        totalCost,
        description,
        date,
      });
    } else {
      // Create new
      console.log(`[syncService] Creating new Master Cost for TimeEntry ${timeEntryId}`);
      const created = await monday.createMasterCostItem({
        workOrderId: entry.workOrderRef,
        workOrderLabel: entry.workOrderLabel || "",
        name: `Labor: ${entry.technician.name}`,
        type,
        quantity,
        rate,
        totalCost,
        description,
        date,
        mondayUserId: entry.technicianId,
        technicianBoardItemId,
      });

      // Save ID back to DB
      await prisma.timeEntry.update({
        where: { id: entry.id },
        data: { masterCostItemId: created.id },
      });
    }
  } catch (err) {
    console.error(`[syncService] Error syncing TimeEntry ${timeEntryId}:`, err.message);
    throw err;
  }
}

/**
 * Syncs an Expense to the Master Costs board.
 * One Expense = Exactly One Master Cost (Expense).
 */
async function syncExpenseToCost(expenseId) {
  try {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { timeEntry: { include: { technician: true } } },
    });

    if (!expense) {
      console.error(`[syncService] Expense ${expenseId} not found.`);
      return;
    }

    const workOrderRef = expense.timeEntry.workOrderRef;
    if (!workOrderRef) {
      console.log(`[syncService] Expense ${expenseId} has no associated Work Order. Skipping cost sync.`);
      return;
    }

    const type = "Expense";
    const quantity = 1;
    const rate = parseFloat(expense.amount);
    const totalCost = rate;
    const date = toCSTDateString(expense.createdAt);
    const description = `${expense.type}: ${expense.details || ""} (by ${expense.timeEntry.technician.name})`;

    // Look up the Technicians board item ID so the board_relation column can be set
    let technicianBoardItemId = null;
    if (expense.timeEntry.technician?.email) {
      try {
        const techItem = await monday.getTechnicianByEmail(expense.timeEntry.technician.email);
        technicianBoardItemId = techItem?.mondayItemId ?? null;
      } catch (_) { /* non-fatal */ }
    }

    if (expense.masterCostItemId) {
      // Update existing
      console.log(`[syncService] Updating existing Master Cost ${expense.masterCostItemId} for Expense ${expenseId}`);
      await monday.updateMasterCostItem(expense.masterCostItemId, {
        name: `${expense.type}: ${expense.timeEntry.technician.name}`,
        rate,
        totalCost,
        description,
        date,
      });
    } else {
      // Create new
      console.log(`[syncService] Creating new Master Cost for Expense ${expenseId}`);
      const created = await monday.createMasterCostItem({
        workOrderId: workOrderRef,
        workOrderLabel: expense.timeEntry.workOrderLabel || "",
        name: `${expense.type}: ${expense.timeEntry.technician.name}`,
        type,
        quantity,
        rate,
        totalCost,
        description,
        date,
        mondayUserId: expense.timeEntry.technicianId,
        technicianBoardItemId,
      });

      // Save ID back to DB
      await prisma.expense.update({
        where: { id: expense.id },
        data: { masterCostItemId: created.id },
      });
    }
  } catch (err) {
    console.error(`[syncService] Error syncing Expense ${expenseId}:`, err.message);
    throw err;
  }
}

/**
 * Removes a Master Cost item when its source is deleted.
 */
async function removeCost(masterCostItemId) {
  if (!masterCostItemId) return;
  try {
    console.log(`[syncService] Deleting Master Cost item ${masterCostItemId}`);
    await monday.deleteMasterCostItem(masterCostItemId);
  } catch (err) {
    console.error(`[syncService] Error deleting Master Cost ${masterCostItemId}:`, err.message);
    // Non-fatal, might have been deleted manually on Monday
  }
}

module.exports = {
  syncTimeEntryToCost,
  syncExpenseToCost,
  removeCost,
};
