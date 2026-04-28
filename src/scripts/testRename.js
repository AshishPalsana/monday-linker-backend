require("dotenv").config({ path: require('path').resolve(__dirname, '../../.env') });
const axios = require("axios");

async function check() {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error("MONDAY_API_TOKEN is not set");

  const client = axios.create({
    baseURL: "https://api.monday.com/v2",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "API-Version": "2024-01",
    },
  });

  // I will test with one of the "Test" pulses: 11846463876
  const cv = { name: "Updated Narrative Test" };

  const query = `
    mutation {
      change_multiple_column_values(
        board_id: 18406939306
        item_id: 11846463876
        column_values: "${JSON.stringify(cv).replace(/"/g, '\\"')}"
      ) { id name }
    }
  `;

  try {
    const { data } = await client.post("", { query });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(err);
  }
}

check();
