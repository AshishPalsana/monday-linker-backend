const axios = require('axios');
require('dotenv').config();

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const BOARD_ID = "18402613691";
const WEBHOOK_URL = "https://monday-linker-backend.onrender.com/api/webhooks/monday/item-created";

const query = `
mutation {
  create_webhook (board_id: ${BOARD_ID}, url: "${WEBHOOK_URL}", event: create_item) {
    id
  }
}
`;

async function registerWebhook() {
  if (!MONDAY_API_TOKEN) {
    console.error("Error: MONDAY_API_TOKEN is missing in .env file");
    process.exit(1);
  }

  try {
    const response = await axios.post("https://api.monday.com/v2", 
      { query }, 
      {
        headers: {
          'Authorization': MONDAY_API_TOKEN,
          'Content-Type': 'application/json',
          'API-Version': '2024-01'
        }
      }
    );

    if (response.data.errors) {
      console.error("Monday API Error:", JSON.stringify(response.data.errors, null, 2));
    } else {
      console.log("Success! Webhook Registered ID:", response.data.data.create_webhook.id);
    }
  } catch (error) {
    console.error("HTTP Error:", error.message);
    if (error.response) console.error("Response:", error.response.data);
  }
}

registerWebhook();
