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
  "accounting.invoices",   // Granular
  "accounting.contacts",   // Granular
  "accounting.settings.read", // Required for organization discovery
  "projects",
  "offline_access",
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
 * Extracts a human-readable error message from Xero SDK error objects.
 * Handles both Accounting (v2.0) and Projects (v2.0) API structures.
 * 
 * v15.0 SDK typically uses err.response.data (axios) or err.response.body.
 */
function parseXeroError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;

  const response = err.response;
  const body = response?.data || response?.body || err.body;
  const statusCode = response?.statusCode || response?.status || err.statusCode || err.status;

  let detail = null;

  if (body && typeof body === "object") {
    // 1. Accounting API validation errors (Elements[0].ValidationErrors)
    const elements = body.Elements || body.elements;
    if (Array.isArray(elements) && elements[0]?.ValidationErrors) {
      detail = elements[0].ValidationErrors.map(ve => ve.Message).join("; ");
    } 
    else if (Array.isArray(elements) && elements[0]?.validationErrors) {
      detail = elements[0].validationErrors.map(ve => ve.message).join("; ");
    }
    
    // 2. Projects API / Other keys
    detail = detail || body.Detail || body.detail || body.Message || body.message || body.error;

    // 3. Handle Xero "ModelState" errors (e.g. model.EstimateAmount)
    if (!detail && body.modelState) {
      const ms = body.modelState;
      detail = Object.values(ms).flat().join("; ");
    }

    // 4. Last resort for objects: JSON stringify
    if (!detail) {
      detail = JSON.stringify(body);
    }
  }

  // 4. Fallback to top-level error message
  const finalMessage = detail || err.message || (statusCode ? `HTTP ${statusCode}` : "Xero API Error");

  console.error(`[xeroService] Parsed Error Detail:`, finalMessage);
  if (body) {
    console.log(`[xeroService] Raw Error Body:`, JSON.stringify(body));
  }

  return finalMessage;
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
async function createXeroProject({ workOrderId, workOrderName, contactId, deadlineDays = DEFAULT_DEADLINE_DAYS }) {
  console.log(`[xeroService] createXeroProject — workOrderId=${workOrderId} contactId=${contactId || "MISSING"}`);

  if (!contactId) {
    throw new Error(`Xero Project creation requires a contactId. Please ensure the customer is synced to Xero first.`);
  }

  const { xero, tenantId } = await getAuthenticatedClient();

  // Build a clean project name: "WO-1042 — Ice Machine Repair"
  const projectName = workOrderName && workOrderName !== workOrderId
    ? `${workOrderId} — ${workOrderName}`
    : workOrderId;

  const days = Number(deadlineDays) || 90;
  const deadlineUtc = new Date(
    Date.now() + days * 24 * 60 * 60 * 1000
  );

  console.log(`[xeroService] Creating Xero Project: "${projectName}" deadlineUtc=${deadlineUtc.toISOString()}`);

  let response;
  try {
    response = await xero.projectApi.createProject(tenantId, {
      name:            projectName,
      contactId:       contactId,
      deadlineUtc:     deadlineUtc, // The SDK expects a Date object, not a string
      // Omitted estimateAmount as Xero rejects 0.00
      // Removed hardcoded currencyCode to avoid organization mismatch errors
    });
  } catch (err) {
    const detail = parseXeroError(err);
    throw new Error(`Xero createProject failed: ${detail}`);
  }

  const xeroProjectId = response.body?.projectId;
  if (!xeroProjectId) {
    throw new Error("Xero createProject returned no projectId. Check Xero Project API response.");
  }

  console.log(`[xeroService] ✓ Xero Project created — projectId=${xeroProjectId}`);
  return xeroProjectId;
}

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
    console.log(`[xeroService] Calling createContacts — tenantId=${tenantId} name="${name}"`);
    try {
      const response = await xero.accountingApi.createContacts(tenantId, {
        contacts: [contact],
      });
      return response.body?.contacts?.[0]?.contactID;
    } catch (err) {
      // Full diagnostic dump so we can see the exact shape xero-node throws
      console.error("[xeroService] createContacts threw — typeof:", typeof err, "| constructor:", err?.constructor?.name);
      try {
        console.error("[xeroService] createContacts error dump:", JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})));
      } catch (_) {
        console.error("[xeroService] createContacts error (not serialisable):", String(err));
      }

      // Recovery: If contact ID exists but was deleted/not found in Xero (404)
      const status = err?.response?.statusCode ?? err?.statusCode ?? err?.response?.status ?? err?.status;
      if (xeroContactId && status === 404) {
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
    const detail = parseXeroError(err);
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
    const detail = parseXeroError(err);
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
