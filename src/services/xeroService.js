/**
 * xeroService.js
 *
 * Centralised service for all Xero API interactions.
 * - Manages token lifecycle (reads from DB, auto-refreshes before expiry)
 * - Provides createXeroProject(), closeXeroProject()
 *
 * All business logic that touches Xero MUST go through this module.
 * Never import XeroClient directly in routes or webhooks.
 */

"use strict";

const { XeroClient } = require("xero-node");
const prisma = require("../lib/prisma");

// ── Constants ────────────────────────────────────────────────────────────────

const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.invoices",   // Granular scope (2026 update)
  "accounting.contacts",
  "projects",           // Required for Xero Projects API
  "offline_access",     // Required for refresh_token grant
];

// Refresh the token if it expires within the next 5 minutes
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Default project deadline: 90 days from creation
const DEFAULT_DEADLINE_DAYS = 90;

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Builds a fresh XeroClient configured with our credentials.
 * NOTE: This does NOT set a tokenSet. Call setTokenSet separately.
 */
function buildXeroClient() {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri  = process.env.XERO_REDIRECT_URI;

  if (!clientId || clientId === "PASTE_YOUR_XERO_CLIENT_ID_HERE") {
    throw new Error(
      "XERO_CLIENT_ID is not configured. Add your real Xero app credentials to .env"
    );
  }
  if (!clientSecret || clientSecret === "PASTE_YOUR_XERO_CLIENT_SECRET_HERE") {
    throw new Error(
      "XERO_CLIENT_SECRET is not configured. Add your real Xero app credentials to .env"
    );
  }

  return new XeroClient({
    clientId,
    clientSecret,
    redirectUris: [redirectUri],
    scopes: XERO_SCOPES,
  });
}

/**
 * Refreshes the Xero access token using the stored refresh_token.
 * Updates the DB record with the new token set.
 *
 * @param {object} integration - The Integration record from Prisma
 * @returns {object} Updated integration record
 */
async function refreshAccessToken(integration) {
  console.log("[xeroService] Access token expired or near-expiry — refreshing…");

  const xero = buildXeroClient();

  // Restore the existing token set so xero-node knows the refresh_token
  await xero.setTokenSet({
    access_token:  integration.accessToken,
    refresh_token: integration.refreshToken,
    expires_in:    0, // Force it to treat as expired internally
  });

  let newTokenSet;
  try {
    newTokenSet = await xero.refreshWithRefreshToken(
      process.env.XERO_CLIENT_ID,
      process.env.XERO_CLIENT_SECRET,
      integration.refreshToken
    );
  } catch (err) {
    console.error("[xeroService] Token refresh failed:", err.message);
    throw new Error(
      `Xero token refresh failed: ${err.message}. ` +
      "Please reconnect Xero at Settings → Integrations → Xero."
    );
  }

  const newExpiresAt = BigInt(
    Date.now() + ((newTokenSet.expires_in || 1800) * 1000)
  );

  const updated = await prisma.integration.update({
    where: { provider: "XERO" },
    data: {
      accessToken:  newTokenSet.access_token,
      refreshToken: newTokenSet.refresh_token || integration.refreshToken,
      expiresAt:    newExpiresAt,
    },
  });

  console.log("[xeroService] ✓ Token refreshed successfully");
  return updated;
}

/**
 * Returns an authenticated XeroClient with a valid access token and tenantId.
 * Automatically refreshes the token if it is expired or within the refresh buffer.
 *
 * @throws if Xero is not connected or credentials are missing
 * @returns {{ xero: XeroClient, tenantId: string }}
 */
async function getAuthenticatedClient() {
  let integration = await prisma.integration.findUnique({
    where: { provider: "XERO" },
  });

  if (!integration || !integration.accessToken) {
    throw new Error(
      "Xero is not connected. Please connect via Settings → Integrations → Xero first."
    );
  }

  const now = Date.now();
  const expiresAt = Number(integration.expiresAt);

  // Auto-refresh if expired or within buffer window
  if (now >= expiresAt - REFRESH_BUFFER_MS) {
    integration = await refreshAccessToken(integration);
  }

  const xero = buildXeroClient();

  await xero.setTokenSet({
    access_token:  integration.accessToken,
    refresh_token: integration.refreshToken,
  });

  await xero.updateTenants();

  const tenantId = integration.tenantId;
  if (!tenantId) {
    throw new Error(
      "Xero tenantId is missing. Please disconnect and reconnect Xero at Settings → Integrations."
    );
  }

  return { xero, tenantId };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a new Xero Project for a given Work Order.
 *
 * @param {object} params
 * @param {string} params.workOrderId   - e.g. "WO-1042"
 * @param {string} params.workOrderName - Monday item name / job title
 * @param {number} [params.deadlineDays] - Days from today for project deadline (default 90)
 *
 * @returns {string} xeroProjectId (UUID)
 */
async function createXeroProject({ workOrderId, workOrderName, deadlineDays = DEFAULT_DEADLINE_DAYS }) {
  console.log(`[xeroService] createXeroProject — workOrderId=${workOrderId}`);

  const { xero, tenantId } = await getAuthenticatedClient();

  // Build a clean project name: "WO-1042 — Ice Machine Repair"
  const projectName = workOrderName && workOrderName !== workOrderId
    ? `${workOrderId} — ${workOrderName}`
    : workOrderId;

  const deadlineUtc = new Date(
    Date.now() + deadlineDays * 24 * 60 * 60 * 1000
  ).toISOString();

  console.log(`[xeroService] Creating Xero Project: "${projectName}" deadlineUtc=${deadlineUtc}`);

  let response;
  try {
    response = await xero.projectApi.createProject(tenantId, {
      name:            projectName,
      deadlineUtc:     deadlineUtc,
      estimateAmount:  0,
      currencyCode:    "AUD", // Adjust to your currency if needed (USD, NZD, etc.)
    });
  } catch (err) {
    // xero-node wraps HTTP errors — extract useful info
    const body = err.response?.body;
    const detail = body?.Detail || body?.Message || err.message;
    console.error("[xeroService] Xero createProject API error:", detail);
    throw new Error(`Xero createProject failed: ${detail}`);
  }

  const xeroProjectId = response.body?.projectId;
  if (!xeroProjectId) {
    throw new Error("Xero createProject returned no projectId. Check Xero Project API response.");
  }

  console.log(`[xeroService] ✓ Xero Project created — projectId=${xeroProjectId}`);
  return xeroProjectId;
}

/**
 * Creates or updates a Contact in Xero.
 *
 * @param {object} params
 * @param {string} params.name           - Customer Name
 * @param {string} [params.email]        - Email
 * @param {string} [params.phone]        - Phone
 * @param {string} [params.addressLine1] - Structured Line 1
 * @param {string} [params.addressLine2] - Structured Line 2
 * @param {string} [params.city]         - City
 * @param {string} [params.state]        - State/Region
 * @param {string} [params.zip]          - ZIP Code
 * @param {string} [params.country]      - Country
 * @param {string} [params.address]      - Fallback combined address
 * @param {string} [params.accountNumber]- Monday Customer Account Number (e.g. CUST-1045)
 *
 * @returns {string} xeroContactId (UUID)
 */
/**
 * Creates or updates a Contact in Xero.
 * Hardened with:
 * - Idempotency: Uses xeroContactId to update instead of create.
 * - Recovery: If contact is missing (404), it clears the ID and creates a new one.
 * - Timeout: Aborts after 10s.
 */
async function createXeroContact({
  name,
  email,
  phone,
  addressLine1,
  addressLine2,
  city,
  state,
  zip,
  country,
  address,
  accountNumber,
  xeroContactId, // Optional, for updates
}) {
  console.log(`[xeroService] createXeroContact — name="${name}" xeroContactId=${xeroContactId || "NEW"}`);

  const { xero, tenantId } = await getAuthenticatedClient();

  const contact = {
    contactID: xeroContactId || undefined,
    name,
    emailAddress: email || undefined,
    accountNumber: accountNumber || undefined,
    phones: phone ? [{ phoneType: "DEFAULT", phoneNumber: phone }] : [],
    addresses: [{
      addressType: "POBOX",
      addressLine1: addressLine1 || address || undefined,
      addressLine2: addressLine2 || undefined,
      city: city || undefined,
      region: state || undefined,
      postalCode: zip || undefined,
      country: country || undefined,
    }],
  };

  const syncTask = async () => {
    try {
      const response = await xero.accountingApi.createContacts(tenantId, {
        contacts: [contact],
      });
      return response.body?.contacts?.[0]?.contactID;
    } catch (err) {
      // Recovery: If contact ID exists but was deleted/not found in Xero (404)
      if (xeroContactId && (err.response?.status === 404 || err.status === 404)) {
        console.warn(`[xeroService] Contact ${xeroContactId} not found in Xero. Retrying as new creation.`);
        delete contact.contactID;
        const retryResponse = await xero.accountingApi.createContacts(tenantId, {
          contacts: [contact],
        });
        return retryResponse.body?.contacts?.[0]?.contactID;
      }
      throw err;
    }
  };

  // 10s Timeout Guard
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT: Xero API took longer than 10s")), 10000);
  });

  try {
    const resultId = await Promise.race([syncTask(), timeoutPromise]);
    if (!resultId) throw new Error("Xero API returned no contactID.");

    console.log(`[xeroService] ✓ Xero Contact synced — contactId=${resultId}`);
    return resultId;
  } catch (err) {
    const body = err.response?.body;
    const detail = body?.Elements?.[0]?.ValidationErrors?.[0]?.Message || body?.Message || err.message;
    console.error("[xeroService] Sync error:", detail);
    throw new Error(detail);
  }
}

/**
 * Updates the status of a Xero Project (e.g., close when WO is complete).
 *
 * @param {string} xeroProjectId - UUID of the Xero Project
 * @param {"INPROGRESS"|"CLOSED"} status
 */
async function updateXeroProjectStatus(xeroProjectId, status) {
  console.log(`[xeroService] updateXeroProjectStatus — projectId=${xeroProjectId} status=${status}`);

  const { xero, tenantId } = await getAuthenticatedClient();

  try {
    await xero.projectApi.patchProject(tenantId, xeroProjectId, { status });
    console.log(`[xeroService] ✓ Xero Project status updated to ${status}`);
  } catch (err) {
    const body = err.response?.body;
    const detail = body?.Detail || body?.Message || err.message;
    console.error("[xeroService] Xero patchProject error:", detail);
    throw new Error(`Xero patchProject failed: ${detail}`);
  }
}

module.exports = {
  createXeroProject,
  updateXeroProjectStatus,
  createXeroContact,
  getAuthenticatedClient,
  XERO_SCOPES,
  buildXeroClient,
};
