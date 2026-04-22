const axios = require("axios");
require("dotenv").config();

async function getBoards() {
  const token = process.env.MONDAY_API_TOKEN;
  const res = await axios.post("https://api.monday.com/v2", 
    { query: "{ boards (limit: 10) { id name } }" },
    { headers: { Authorization: token, "API-Version": "2024-01" } }
  );
  console.log(JSON.stringify(res.data, null, 2));
}

getBoards();
