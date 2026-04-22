const { XeroClient } = require("xero-node");
const client = new XeroClient({});
console.log("Project API methods:", Object.keys(client.projectApi));
