
const axios = require("axios");

const MONDAY_API_URL = "https://api.monday.com/v2";

// ── Board / Column constants ────────────────────────────
const BOARD = {
  WORK_ORDERS:   "18402613691",
  TIME_ENTRIES:  "18406939306",
  EXPENSES:      "18406939432",
  CUSTOMERS:     "18400951947",
  LOCATIONS:     "18400965227",
  MASTER_COSTS:  "18407330739",
  INVOICE_ITEMS: "18403393439",
};


const COL = {
  WORK_ORDERS: {
    EXECUTION_STATUS: "color_mm1s7ak1",
    WORKORDER_ID:     "text_mm1s82bz",
    BILLING_STAGE:    "color_mm2dgedg",
    CUSTOMER:         "board_relation_mm2ctcg0",
    LOCATION:         "board_relation_mm2czk6k",
    MASTER_COSTS_REL: "board_relation_mm26prz0",
    TIME_ENTRIES_REL: "board_relation_mm2cnxb5",
    EXPENSES_REL:     "board_relation_mm2cgry0",
    WORK_PERFORMED:   "long_text_mm15kfzp",
    DESCRIPTION:      "long_text_mm14ee7h",
  },
  CUSTOMERS: {
    ACCOUNT_NUMBER:   "text_mm0ryhr9",
    EMAIL:            "email_mm0rhasv",
    PHONE:            "phone_mm0rpam7",
  },
  LOCATIONS: {
    STREET:           "text_mm0r64n",
    CITY:             "text_mm0rv9zr",
    STATE:            "dropdown_mm0r9ajj",
    ZIP:              "text_mm0rrexv",
  },
  TIME_ENTRIES: {
    TOTAL_HOURS:      "numeric_mm21p49k",
    CLOCK_IN:         "date_mm21zkpj",
    CLOCK_OUT:        "date_mm2155gg",
    TASK_TYPE:        "dropdown_mm21wscp",
    WORK_ORDERS_REL:  "board_relation_mm2cy69m",
    TECHNICIANS:      "multiple_person_mm21m56s",
    LOCATIONS_REL:    "board_relation_mm21vtd1",
    EXPENSES_ADDED:   "boolean_mm212dcy",
  },
  EXPENSES: {
    TECHNICIAN:       "multiple_person_mm212yhb",
    TIME_ENTRY_REL:   "board_relation_mm2cdgz8",
    WORK_ORDER_REL:   "board_relation_mm2cw5x5",  // board_relation (was wrong text col)
    RECEIPT:          "file_mm21j7d7",
    DESCRIPTION:      "text_mm213m15",
    EXPENSE_TYPE:     "dropdown_mm215jhc",
    AMOUNT:           "numeric_mm21a0kv",
  },
  MASTER_COSTS: {
    WORK_ORDERS_REL:  "board_relation_mm26prz0",
    TECHNICIANS_REL:  "board_relation_mm26z5dh",
    TYPE:             "color_mm25xk4h",   // Labor | Parts | Expense
    QUANTITY:         "numeric_mm256yw2",
    RATE:             "numeric_mm25xvx0",
    DESCRIPTION:      "text_mm25nhbc",
    TOTAL_COST:       "numeric_mm25953b",
    DATE:             "date_mm26snwa",
    INVOICE_STATUS:   "color_mm26qn4h",
  },
  INVOICE_ITEMS: {
    WORK_ORDERS_REL:  "board_relation_mm1ae4as",
    ITEM_TYPE:        "dropdown_mm1ae5fd",
    QUANTITY:         "numeric_mm1ab4nj",
    UNIT_PRICE:       "numeric_mm1a6h84",
    BILLING_STATUS:   "color_mm1ae7q7",
    INVOICE_ID:       "text_mm1ay1cy",
    DESCRIPTION:      "long_text_mm1cdk36",
    REVENUE_ACCOUNT:  "color_mm1csz5m",
  },
};

// Dropdown label → Monday.com dropdown ID for the Expenses board
const EXPENSE_TYPE_IDS = {
  Fuel:     1,
  Lodging:  2,
  Meals:    3,
  Supplies: 4,
};

const WORK_ORDER_STATUS = {
  // Scheduling Statuses
  INCOMPLETE:               "Incomplete",
  UNSCHEDULED:              "Unscheduled",
  SCHEDULED:                "Scheduled",
  PRE_SCHEDULED:            "Pre-scheduled",
  RETURN_TRIP_UNSCHEDULED:  "Return Trip Unscheduled",
  RETURN_TRIP_SCHEDULED:    "Return Trip Scheduled",
  
  // Progress Statuses
  IN_PROGRESS:              "In Progress",
  ADDITIONAL_TRIP_PARTS:    "Additional Trip Needed (parts ordered)",
  ADDITIONAL_TRIP_NEED_PARTS:"Additional Trip Needed (need parts)",
  ADDITIONAL_TRIP_TIME:     "Additional Trip Needed (Time Only)",
  COMPLETE:                 "Completed",
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

async function setWorkOrderExecutionStatus(workOrderItemId, statusLabel) {
  if (!workOrderItemId || !statusLabel) return;
  const cv = { [COL.WORK_ORDERS.EXECUTION_STATUS]: { label: statusLabel } };

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

async function setWorkOrderInProgress(workOrderItemId) {
  return setWorkOrderExecutionStatus(workOrderItemId, WORK_ORDER_STATUS.IN_PROGRESS);
}


async function setWorkOrderComplete(workOrderItemId) {
  return setWorkOrderExecutionStatus(workOrderItemId, WORK_ORDER_STATUS.COMPLETE);
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

async function updateTimeEntryItem(mondayItemId, { clockOut, hoursWorked, hasExpenses = false, narrative = "", jobLocation = "", workOrderRef = null }) {
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

  // 1. Update the Time Entry board
  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.TIME_ENTRIES}
        item_id: ${mondayItemId}
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);

  // 2. If it's a Job, sync the narrative to the Work Order board
  if (workOrderRef && narrative) {
    try {
      await appendWorkOrderNarrative(workOrderRef, { text: narrative, location: jobLocation || null });
    } catch (err) {
      console.error("[updateTimeEntryItem] Failed to sync narrative to Work Order:", err.message);
    }
  }

  // 3. Move to Completed group
  await graphql(`
    mutation {
      move_item_to_group(
        item_id: ${mondayItemId}
        group_id: "group_mm21shsk"
      ) { id }
    }
  `);
}

/**
 * Appends a narrative to the Work Order's "Work Performed" column.
 */
async function appendWorkOrderNarrative(workOrderItemId, newNarrative) {
  if (!workOrderItemId || !newNarrative) return;

  // First, fetch current text to append (to avoid overwriting previous days' work)
  const result = await graphql(`
    query {
      items(ids: [${workOrderItemId}]) {
        column_values(ids: ["${COL.WORK_ORDERS.WORK_PERFORMED}"]) {
          text
        }
      }
    }
  `);

  const currentText = result.items[0]?.column_values[0]?.text || "";
  const dateStr = new Date().toLocaleDateString();
  const separator = currentText ? "\n\n---\n" : "";
  const locationInfo = newNarrative.location ? ` [Location: ${newNarrative.location}]` : "";
  const updatedText = `${currentText}${separator}[${dateStr}]${locationInfo}\n${newNarrative.text || newNarrative}`;

  const cv = { [COL.WORK_ORDERS.WORK_PERFORMED]: updatedText };

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
/**
 * Create an Expense item on the Monday.com Expenses board
 * @param {object} params
 * @param {string} params.mondayUserId       - Monday.com person ID (numeric string)
 * @param {string} params.type               - "Fuel" | "Lodging" | "Meals" | "Supplies"
 * @param {number} params.amount
 * @param {string} params.details
 * @param {string} params.workOrderId        - Monday.com item ID for the Work Order (numeric string)
 * @param {string} params.timeEntryMondayId  - Monday.com item ID for the Time Entry (numeric string)
 * @param {string} params.expenseItemName    - name for the Monday.com item
 */
async function createExpenseItem({
  mondayUserId,
  type,
  amount,
  details,
  workOrderId,
  timeEntryMondayId,
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
  
  // Link to Work Order via board_relation
  if (workOrderId) {
    cv[COL.EXPENSES.WORK_ORDER_REL] = { item_ids: [parseInt(workOrderId, 10)] };
  }

  // Link to Time Entry via board_relation
  if (timeEntryMondayId) {
    cv[COL.EXPENSES.TIME_ENTRY_REL] = { item_ids: [parseInt(timeEntryMondayId, 10)] };
  }

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
      // Ignore numbers larger than 2,147,483,647 (Postgres INT4 limit)
      if (num < 2147483647 && num > maxId) {
        maxId = num;
      }
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

/**
 * Fetches details for a Location item.
 */
async function getLocationDetails(itemId) {
  const result = await graphql(`
    query {
      items(ids: [${itemId}]) {
        name
        column_values(ids: [
          "text_mm0r64n", 
          "text_mm0rv9zr", 
          "dropdown_mm0r9ajj", 
          "text_mm0rrexv"
        ]) {
          id
          text
        }
      }
    }
  `);

  const item = result.items[0];
  if (!item) return null;

  const cv = id => item.column_values.find(c => c.id === id)?.text || "";

  return {
    name: item.name,
    streetAddress: cv("text_mm0r64n"),
    city: cv("text_mm0rv9zr"),
    state: cv("dropdown_mm0r9ajj"),
    zip: cv("text_mm0rrexv")
  };
}

/**
 * Fetches details for a Work Order item.
 */
async function getWorkOrderDetails(itemId) {
  const result = await graphql(`
    query {
      items(ids: [${itemId}]) {
        name
        column_values(ids: ["board_relation_mm2czk6k"]) {
          id
          value
          text
        }
      }
    }
  `);

  const item = result.items[0];
  if (!item) return null;

  const locCol = item.column_values.find(c => c.id === "board_relation_mm2czk6k");
  let locationId = null;
  if (locCol?.value) {
    try {
      const parsed = JSON.parse(locCol.value);
      locationId = parsed.linkedPulseIds?.[0]?.linkedPulseId || null;
    } catch(e) {}
  }

  return {
    name: item.name,
    locationId
  };
}

module.exports = {
  setWorkOrderExecutionStatus,
  setWorkOrderInProgress,
  setWorkOrderComplete,
  createTimeEntryItem,
  updateTimeEntryItem,
  createExpenseItem,
  updateWorkOrderId,
  updateCustomerAccountNumber,
  getLatestWorkOrderIdFromBoard,
  getLatestCustomerAccountNumberFromBoard,
  getLocationDetails,
  getWorkOrderDetails,
  getMasterCosts,
  createMasterCostItem,
  updateMasterCostItem,
  deleteMasterCostItem,
  createInvoiceItem,
  setInvoiceItemStatus,
  BOARD,
  COL,
  EXPENSE_TYPE_IDS,
  WORK_ORDER_STATUS,
};

// ── Master Costs ─────────────────────────────────────────────────────────────

/**
 * Fetches all Master Cost items, optionally filtered by a Work Order Monday ID.
 * @param {string|null} workOrderId
 */
/**
 * Fetches all Master Cost items, optionally filtered by a Work Order Monday ID.
 * @param {string|null} workOrderId
 */
async function getMasterCosts(workOrderId) {
  const MC = COL.MASTER_COSTS;

  // If workOrderId provided, filter via linked_items API
  if (workOrderId) {
    const result = await graphql(`
      query {
        items(ids: [${workOrderId}]) {
          linked_items(link_to_item_column_id: "${MC.WORK_ORDERS_REL}", linked_board_id: ${BOARD.MASTER_COSTS}) {
            id
            name
            created_at
            column_values(ids: [
              "${MC.TYPE}",
              "${MC.QUANTITY}",
              "${MC.RATE}",
              "${MC.TOTAL_COST}",
              "${MC.DESCRIPTION}",
              "${MC.DATE}",
              "${MC.INVOICE_STATUS}"
            ]) { id text value }
          }
        }
      }
    `);
    return result.items?.[0]?.linked_items ?? [];
  }

  const result = await graphql(`
    query {
      boards(ids: [${BOARD.MASTER_COSTS}]) {
        items_page(limit: 200) {
          items {
            id
            name
            created_at
            column_values(ids: [
              "${MC.TYPE}",
              "${MC.QUANTITY}",
              "${MC.RATE}",
              "${MC.TOTAL_COST}",
              "${MC.DESCRIPTION}",
              "${MC.DATE}",
              "${MC.INVOICE_STATUS}",
              "${MC.WORK_ORDERS_REL}"
            ]) { id text value }
          }
        }
      }
    }
  `);
  return result.boards?.[0]?.items_page?.items ?? [];
}

/**
 * Creates a new item on the Master Costs board.
 */
async function createMasterCostItem({ workOrderId, workOrderLabel, type, quantity, rate, totalCost, description, date, mondayUserId }) {
  const MC  = COL.MASTER_COSTS;
  const cv  = {};

  cv[MC.TYPE]       = { label: type };
  cv[MC.QUANTITY]   = quantity;
  cv[MC.RATE]       = rate;
  cv[MC.TOTAL_COST] = totalCost;
  if (description) cv[MC.DESCRIPTION] = { text: description };
  if (date)        cv[MC.DATE]        = { date };

  const itemName = `${type} — ${description || workOrderLabel || ""}`.slice(0, 100);

  const result = await graphql(`
    mutation {
      create_item(
        board_id: ${BOARD.MASTER_COSTS},
        group_id: "topics",
        item_name: ${JSON.stringify(itemName)},
        column_values: ${JSON.stringify(JSON.stringify(cv))}
      ) { id name }
    }
  `);

  const created = result.create_item;
  if (!created?.id) throw new Error("Master Costs: create_item returned no id");

  if (workOrderId) {
    await graphql(`
      mutation {
        change_column_value(
          board_id: ${BOARD.MASTER_COSTS},
          item_id: ${created.id},
          column_id: "${MC.WORK_ORDERS_REL}",
          value: "${JSON.stringify({ item_ids: [parseInt(workOrderId)] }).replace(/"/g, '\\"')}"
        ) { id }
      }
    `);
  }

  return created;
}

/**
 * Updates columns on an existing Master Costs item.
 */
async function updateMasterCostItem(mondayItemId, updates) {
  const MC  = COL.MASTER_COSTS;
  const cv  = {};

  if (updates.type        !== undefined) cv[MC.TYPE]       = { label: updates.type };
  if (updates.quantity    !== undefined) cv[MC.QUANTITY]   = updates.quantity;
  if (updates.rate        !== undefined) cv[MC.RATE]       = updates.rate;
  if (updates.totalCost   !== undefined) cv[MC.TOTAL_COST] = updates.totalCost;
  if (updates.description !== undefined) cv[MC.DESCRIPTION]= { text: updates.description };
  if (updates.date        !== undefined) cv[MC.DATE]       = { date: updates.date };

  if (!Object.keys(cv).length) return;

  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.MASTER_COSTS},
        item_id: ${mondayItemId},
        column_values: ${JSON.stringify(JSON.stringify(cv))}
      ) { id }
    }
  `);
}

/**
 * Deletes a Master Costs item.
 */
async function deleteMasterCostItem(mondayItemId) {
  await graphql(`
    mutation {
      delete_item(item_id: ${mondayItemId}) { id }
    }
  `);
}

/**
 * Creates an item on the Invoice Line Items board.
 */
async function createInvoiceItem({ 
  workOrderId, 
  type, 
  quantity, 
  unitPrice, 
  description,
  itemName 
}) {
  const INV = COL.INVOICE_ITEMS;
  const cv = {};

  cv[INV.QUANTITY]    = quantity;
  cv[INV.UNIT_PRICE]  = unitPrice;
  if (description) cv[INV.DESCRIPTION] = { text: description };
  
  const typeId = type === "Labor" ? 1 : 2; 
  cv[INV.ITEM_TYPE] = { ids: [typeId] };

  const result = await graphql(`
    mutation {
      create_item(
        board_id: ${BOARD.INVOICE_ITEMS},
        group_id: "topics",
        item_name: "${esc(itemName || description || "Invoice Item")}",
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);

  const createdId = result.create_item.id;

  if (workOrderId) {
    await graphql(`
      mutation {
        change_column_value(
          board_id: ${BOARD.INVOICE_ITEMS},
          item_id: ${createdId},
          column_id: "${INV.WORK_ORDERS_REL}",
          value: "${JSON.stringify({ item_ids: [parseInt(workOrderId)] }).replace(/"/g, '\\"')}"
        ) { id }
      }
    `);
  }

  return createdId;
}

/**
 * Updates the Billing Status on an Invoice Line Item.
 */
async function setInvoiceItemStatus(itemId, statusLabel) {
  const INV = COL.INVOICE_ITEMS;
  const cv = { [INV.BILLING_STATUS]: { label: statusLabel } };

  await graphql(`
    mutation {
      change_multiple_column_values(
        board_id: ${BOARD.INVOICE_ITEMS},
        item_id: ${itemId},
        column_values: "${esc(JSON.stringify(cv))}"
      ) { id }
    }
  `);
}



