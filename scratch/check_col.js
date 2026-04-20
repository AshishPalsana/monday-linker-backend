const axios = require("axios");
require("dotenv").config();

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const BOARD_ID = "18406939306";
const COLUMN_ID = "dropdown_mm21wscp";

async function checkColumn() {
  try {
    const response = await axios.post("https://api.monday.com/v2", 
      {
        query: `query { boards(ids: [${BOARD_ID}]) { columns(ids: ["${COLUMN_ID}"]) { settings_str } } }`
      },
      {
        headers: {
          'Authorization': MONDAY_API_TOKEN,
          'Content-Type': 'application/json',
          'API-Version': '2024-01'
        }
      }
    );
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error(error.message);
  }
}

checkColumn();
