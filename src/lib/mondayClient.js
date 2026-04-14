
const axios = require("axios");

const MONDAY_API_URL = "https://api.monday.com/v2";

// ── Board / Column constants ────────────────────────────
const BOARD = {
  WORK_ORDERS:   "18402613691",
  TIME_ENTRIES:  "18406939306",
  EXPENSES:      "18406939432",
  CUSTOMERS:     "18400951947",
};

const COL = {
  WORK_ORDERS: {
    EXECUTION_STATUS: "color_mm1s7ak1",
    WORKORDER_ID:     "text_mm1s82bz",
  },
  CUSTOMERS: {
    ACCOUNT_NUMBER:   "text_mm0ryhr9",
  },
  TIME_ENTRIES: {
    TOTAL_HOURS:      "numeric_mm21p49k",
    CLOCK_IN:         "date_mm21zkpj",
    CLOCK_OUT:        "date_mm2155gg",
    TASK_TYPE:        "dropdown_mm21wscp",
    WORK_ORDERS_REL:  "board_relation_mm21aenv",
    TECHNICIANS:      "multiple_person_mm21m56s",
    LOCATIONS_REL:    "board_relation_mm21vtd1",
    EXPENSES_ADDED:   "boolean_mm212dcy",
  },
  EXPENSES: {
    TECHNICIAN:       "multiple_person_mm212yhb",
    RECEIPT:          "file_mm21j7d7",
    DESCRIPTION:      "text_mm213m15",
    EXPENSE_TYPE:     "dropdown_mm215jhc",
    WORK_ORDER:       "text_mm218mcp",
    AMOUNT:           "numeric_mm21a0kv",
  },
};

// Dropdown label → Monday.com dropdown ID for the Expenses board
const EXPENSE_TYPE_IDS = {
  Fuel:     1,
  Lodging:  2,
  Meals:    3,
  Supplies: 4,
};

// ── Helper ──────────────────────────────────────────────
function getClient() {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN is not set");

  return axios.create({
    baseURL: MONDAY_API_URL,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "API-Version":  "2024-01",
    },
  });
}

function esc(str) {
  return (str || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

async function graphql(query, retries = 3) {
  const client = getClient();
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      const { data } = await client.post("", { query });
      if (data.errors?.length) {
        const msg = data.errors.map((e) => e.message).join("; ");
        throw new Error(`Monday.com API error: ${msg}`);
      }
      return data.data;
    } catch (err) {
      lastError = err;
      console.warn(`[mondayClient] Attempt ${i + 1} failed: ${err.message}`);
      if (i < retries - 1) {
        // Exponential backoff
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 1000));
      }
    }
  }
  throw lastError;
}

async function setWorkOrderInProgress(workOrderItemId) {
  if (!workOrderItemId) return;
  const cv = { [COL.WORK_ORDERS.EXECUTION_STATUS]: { label: "In Progress" } };

  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.WORK_ORDERS}
        item_id: ${workOrderItemId}
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);
}

async function setWorkOrderComplete(workOrderItemId) {
  if (!workOrderItemId) return;
  const cv = { [COL.WORK_ORDERS.EXECUTION_STATUS]: { label: "Completed" } };

  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.WORK_ORDERS}
        item_id: ${workOrderItemId}
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);
}

async function createTimeEntryItem({
  technicianName,
  mondayUserId,
  entryType,
  workOrderRef,
  workOrderLabel,
  taskDescription,
  clockIn,
}) {
  const taskTypeId = entryType === "Job" ? 1 : 2; // Job=1, Non-Job=2 in Time Entries dropdown

  const itemName = entryType === "Job"
    ? (workOrderLabel || "Job Entry")
    : (taskDescription || "Non-Job Entry");

  const cv = {};

  // Clock In Time
  cv[COL.TIME_ENTRIES.CLOCK_IN] = {
    date: clockIn.toISOString().split("T")[0],
    time: clockIn.toISOString().split("T")[1].split(".")[0],
  };

  // Task Type dropdown
  cv[COL.TIME_ENTRIES.TASK_TYPE] = { ids: [taskTypeId] };

  // Link to Work Order board item
  if (entryType === "Job" && workOrderRef) {
    cv[COL.TIME_ENTRIES.WORK_ORDERS_REL] = { item_ids: [parseInt(workOrderRef, 10)] };
  }

  const result = await graphql(`
    mutation {
      create_item(
        board_id: ${BOARD.TIME_ENTRIES}
        group_id: "topics"
        item_name: "${esc(itemName)}"
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);

  const newItemId = result.create_item.id;

  // Assign technician separately — people column IDs can differ from auth user IDs,
  // so we isolate this to avoid failing the whole item creation
  if (mondayUserId) {
    const peopleCv = {
      [COL.TIME_ENTRIES.TECHNICIANS]: {
        personsAndTeams: [{ id: parseInt(mondayUserId, 10), kind: "person" }],
      },
    };
    await graphql(`
      mutation {
        change_multiple_column_values(
          board_id: ${BOARD.TIME_ENTRIES}
          item_id: ${newItemId}
          column_values: "${esc(JSON.stringify(peopleCv))}"
        ) { id }
      }
    `).catch((err) => {
      console.warn("[createTimeEntryItem] Could not assign technician to people column:", err.message);
    });
  }

  return newItemId;
}

async function updateTimeEntryItem(mondayItemId, { clockOut, hoursWorked, hasExpenses = false }) {
  if (!mondayItemId) return;

  const cv = {};

  cv[COL.TIME_ENTRIES.CLOCK_OUT] = {
    date: clockOut.toISOString().split("T")[0],
    time: clockOut.toISOString().split("T")[1].split(".")[0],
  };

  cv[COL.TIME_ENTRIES.TOTAL_HOURS] = String(hoursWorked);

  if (hasExpenses) {
    cv[COL.TIME_ENTRIES.EXPENSES_ADDED] = { checked: true };
  }

  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.TIME_ENTRIES}
        item_id: ${mondayItemId}
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);

  // Move to Completed group
  await graphql(`
    mutation {
      move_item_to_group(
        item_id: ${mondayItemId}
        group_id: "group_mm21shsk"
      ) { id }
    }
  `);
}

// ── Expenses board ──────────────────────────────────────

/**
 * Create an Expense item on the Monday.com Expenses board
 * @param {object} params
 * @param {string} params.mondayUserId       - Monday.com person ID (numeric string)
 * @param {string} params.type               - "Fuel" | "Lodging" | "Meals" | "Supplies"
 * @param {number} params.amount
 * @param {string} params.details
 * @param {string} params.workOrderLabel     - display label or WO ID for the Work Order text column
 * @param {string} params.expenseItemName    - name for the Monday.com item
 */
async function createExpenseItem({
  mondayUserId,
  type,
  amount,
  details,
  workOrderLabel,
  expenseItemName,
}) {
  const typeId = EXPENSE_TYPE_IDS[type];
  if (!typeId) throw new Error(`Unknown expense type: ${type}`);

  const cv = {};

  if (mondayUserId) {
    cv[COL.EXPENSES.TECHNICIAN] = {
      personsAndTeams: [{ id: parseInt(mondayUserId, 10), kind: "person" }],
    };
  }

  if (details) cv[COL.EXPENSES.DESCRIPTION] = details;
  cv[COL.EXPENSES.EXPENSE_TYPE] = { ids: [typeId], override_all_ids: "true" };
  cv[COL.EXPENSES.AMOUNT] = String(amount);
  if (workOrderLabel) cv[COL.EXPENSES.WORK_ORDER] = workOrderLabel;

  const result = await graphql(`
    mutation {
      create_item(
        board_id: ${BOARD.EXPENSES}
        group_id: "topics"
        item_name: "${esc(expenseItemName || `${type} expense`)}"
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);

  return result.create_item.id;
}

async function updateWorkOrderId(itemId, newId) {
  if (!itemId || !newId) return;
  const cv = { [COL.WORK_ORDERS.WORKORDER_ID]: newId };

  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.WORK_ORDERS}
        item_id: ${itemId}
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);
}

async function updateCustomerAccountNumber(itemId, newId) {
  if (!itemId || !newId) return;
  const cv = { [COL.CUSTOMERS.ACCOUNT_NUMBER]: newId };

  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.CUSTOMERS}
        item_id: ${itemId}
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);
}

/**
 * Fetches the numeric part of the latest ID from a specific board/column.
 * Used for seeding the sequential ID counter.
 */
async function getLatestNumericIdFromBoard(boardId, columnId) {
  console.log(`[mondayClient] getLatestNumericIdFromBoard — board=${boardId} col=${columnId}`);

  const result = await graphql(`
    query {
      boards(ids: [${boardId}]) {
        items_page(limit: 100) {
          items {
            id
            column_values(ids: ["${columnId}"]) {
              text
            }
          }
        }
      }
    }
  `);

  const items = result.boards[0]?.items_page?.items || [];
  console.log(`[mondayClient] Fetched ${items.length} items from board ${boardId}`);

  let maxId = 0;
  items.forEach(item => {
    const text = item.column_values[0]?.text || "";
    const match = text.match(/\d+$/);
    if (match) {
      const num = parseInt(match[0], 10);
      if (num > maxId) maxId = num;
    }
  });

  console.log(`[mondayClient] getLatestNumericIdFromBoard — returning maxNum=${maxId}`);
  return maxId;
}

async function getLatestWorkOrderIdFromBoard() {
  return getLatestNumericIdFromBoard(BOARD.WORK_ORDERS, COL.WORK_ORDERS.WORKORDER_ID);
}

async function getLatestCustomerAccountNumberFromBoard() {
  return getLatestNumericIdFromBoard(BOARD.CUSTOMERS, COL.CUSTOMERS.ACCOUNT_NUMBER);
}

module.exports = {
  setWorkOrderInProgress,
  setWorkOrderComplete,
  createTimeEntryItem,
  updateTimeEntryItem,
  createExpenseItem,
  updateWorkOrderId,
  updateCustomerAccountNumber,
  getLatestWorkOrderIdFromBoard,
  getLatestCustomerAccountNumberFromBoard,
  BOARD,
  COL,
  EXPENSE_TYPE_IDS,
};
