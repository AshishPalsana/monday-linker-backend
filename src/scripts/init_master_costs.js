const axios = require("axios");
require("dotenv").config();

const MONDAY_API_URL = "https://api.monday.com/v2";
const TOKEN = process.env.MONDAY_API_TOKEN;
const WORK_ORDERS_BOARD_ID = "18402613691";

async function graphql(query) {
  const { data } = await axios.post(MONDAY_API_URL, { query }, {
    headers: { Authorization: TOKEN, "API-Version": "2024-01" }
  });
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

async function init() {
  console.log("Starting Master Costs Board Initialization...");

  try {
    // 1. Create Board
    const boardResult = await graphql(`
      mutation {
        create_board (board_name: "Master Costs", board_kind: public) {
          id
        }
      }
    `);
    const boardId = boardResult.create_board.id;
    console.log(`✓ Board created: ${boardId}`);

    // 2. Create Columns
    // Type (Status)
    const typeCol = await graphql(`
      mutation {
        create_column (board_id: ${boardId}, title: "Type", column_type: status) { id }
      }
    `);
    console.log(`✓ Type column created: ${typeCol.create_column.id}`);

    // Set Status labels
    await graphql(`
      mutation {
        change_column_metadata (board_id: ${boardId}, column_id: "${typeCol.create_column.id}", column_property: labels, value: "{\\\"0\\\":\\\"Labor\\\",\\\"1\\\":\\\"Parts\\\",\\\"2\\\":\\\"Expense\\\"}") { id }
      }
    `);

    // Description
    const descCol = await graphql(`
      mutation {
        create_column (board_id: ${boardId}, title: "Description", column_type: text) { id }
      }
    `);
    console.log(`✓ Description column created: ${descCol.create_column.id}`);

    // Quantity
    const qtyCol = await graphql(`
      mutation {
        create_column (board_id: ${boardId}, title: "Quantity", column_type: numeric) { id }
      }
    `);
    console.log(`✓ Quantity column created: ${qtyCol.create_column.id}`);

    // Rate
    const rateCol = await graphql(`
      mutation {
        create_column (board_id: ${boardId}, title: "Rate", column_type: numeric) { id }
      }
    `);
    console.log(`✓ Rate column created: ${rateCol.create_column.id}`);

    // Total
    const totalCol = await graphql(`
      mutation {
        create_column (board_id: ${boardId}, title: "Total", column_type: numeric) { id }
      }
    `);
    console.log(`✓ Total column created: ${totalCol.create_column.id}`);

    // Work Order Relation
    const relCol = await graphql(`
      mutation {
        create_column (board_id: ${boardId}, title: "Work Order", column_type: board_relation) { id }
      }
    `);
    console.log(`✓ Relation column created: ${relCol.create_column.id}`);

    // Link Relation to Work Orders board
    await graphql(`
      mutation {
        change_column_metadata (board_id: ${boardId}, column_id: "${relCol.create_column.id}", column_property: settings_str, value: "{\\\"boardIds\\\":[${WORK_ORDERS_BOARD_ID}],\\\"allowMultiItems\\\":false}") { id }
      }
    `);

    // 3. Add Aggregation column to Work Orders board
    const woTotalCol = await graphql(`
      mutation {
        create_column (board_id: ${WORK_ORDERS_BOARD_ID}, title: "Total Job Cost", column_type: numeric) { id }
      }
    `);
    console.log(`✓ Work Order 'Total Job Cost' column created: ${woTotalCol.create_column.id}`);

    console.log("\n--- INITIALIZATION COMPLETE ---");
    console.log(`BOARD_ID: ${boardId}`);
    console.log(`TYPE_COL: ${typeCol.create_column.id}`);
    console.log(`DESC_COL: ${descCol.create_column.id}`);
    console.log(`QTY_COL: ${qtyCol.create_column.id}`);
    console.log(`RATE_COL: ${rateCol.create_column.id}`);
    console.log(`TOTAL_COL: ${totalCol.create_column.id}`);
    console.log(`REL_COL: ${relCol.create_column.id}`);
    console.log(`WO_TOTAL_COL: ${woTotalCol.create_column.id}`);

  } catch (err) {
    console.error("Initialization failed:", err.message);
  }
}

init();
