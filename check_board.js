const { mondayClient } = require("./src/lib/mondayClient");
require("dotenv").config();

async function checkBoard() {
  const boardId = "18407330739";
  console.log(`Checking board ${boardId}...`);
  try {
    const query = `query { boards (ids: [${boardId}]) { name columns { id title type } } }`;
    const response = await mondayClient.api(query);
    console.log(JSON.stringify(response, null, 2));
  } catch (err) {
    console.error("Error checking board:", err.message);
  }
}

checkBoard();
