require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const https = require("https");
const { parseAddressHeuristic, combineAddress } = require("../src/utils/addressUtils");

const prisma = new PrismaClient();

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const BOARD_ID = "18400951947"; // Customers Board

const COL = {
  ACCOUNT_NUMBER:   "text_mm0ryhr9",
  EMAIL:            "email_mm0rhasv",
  PHONE:            "phone_mm0rpam7",
  BILLING_ADDRESS:  "long_text_mm0r9ndz",
};

async function graphql(query) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query });
    const options = {
      hostname: "api.monday.com",
      port: 443,
      path: "/v2",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": MONDAY_API_TOKEN,
        "Content-Length": data.length,
        "API-Version": "2023-10"
      }
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        const parsed = JSON.parse(body);
        if (parsed.errors) reject(new Error(parsed.errors[0].message));
        else resolve(parsed.data);
      });
    });

    req.on("error", (e) => reject(e));
    req.write(data);
    req.end();
  });
}

async function migrate() {
  console.log("--- Starting Customer Migration ---");
  
  try {
    const query = `
      query {
        boards(ids: [${BOARD_ID}]) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: [
                "${COL.ACCOUNT_NUMBER}",
                "${COL.EMAIL}",
                "${COL.PHONE}",
                "${COL.BILLING_ADDRESS}"
              ]) {
                id
                text
              }
            }
          }
        }
      }
    `;

    const result = await graphql(query);
    const items = result.boards[0].items_page.items;
    
    console.log(`Found ${items.length} customers in Monday.com`);

    for (const item of items) {
      const cv = (id) => item.column_values.find(c => c.id === id)?.text || null;
      
      const rawAddress = cv(COL.BILLING_ADDRESS);
      const structured = parseAddressHeuristic(rawAddress);
      
      console.log(`Migrating "${item.name}"...`);

      await prisma.customer.upsert({
        where: { id: String(item.id) },
        update: {
          name: item.name,
          email: cv(COL.EMAIL),
          phone: cv(COL.PHONE),
          accountNumber: cv(COL.ACCOUNT_NUMBER),
          addressLine1: structured.addressLine1 || null,
          addressLine2: structured.addressLine2 || null,
          city: structured.city || null,
          state: structured.state || null,
          zip: structured.zip || null,
          country: structured.country || "USA",
          billingAddress: rawAddress
        },
        create: {
          id: String(item.id),
          name: item.name,
          email: cv(COL.EMAIL),
          phone: cv(COL.PHONE),
          accountNumber: cv(COL.ACCOUNT_NUMBER),
          addressLine1: structured.addressLine1 || null,
          addressLine2: structured.addressLine2 || null,
          city: structured.city || null,
          state: structured.state || null,
          zip: structured.zip || null,
          country: structured.country || "USA",
          billingAddress: rawAddress
        }
      });
    }

    console.log("--- Migration Completed Successfully ---");
  } catch (err) {
    console.error("Migration failed:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
