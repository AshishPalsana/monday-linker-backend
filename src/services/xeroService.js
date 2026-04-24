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

// Prevents race conditions where multiple webhooks/routes sync the same pulse simultaneously.
// Callers must bracket the full "sync + Monday write-back" with tryAcquireSyncLock / releaseSyncLock
// so the lock covers the entire critical section, not just the Xero API call.
const pulseSyncLocks = new Map();

function tryAcquireSyncLock(pulseId) {
  const key = String(pulseId);
  if (pulseSyncLocks.has(key)) return false;
  pulseSyncLocks.set(key, true);
  return true;
}

function releaseSyncLock(pulseId) {
  pulseSyncLocks.delete(String(pulseId));
}

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
 * xero-node v15 sometimes throws the entire HTTP response as a JSON *string*
 * rather than a proper Error — this function handles both shapes.
 */
function parseXeroError(err) {
  if (!err) return "Unknown error";

  // Normalize: if xero-node threw the response as a raw JSON string, parse it first
  let normalized = err;
  if (typeof err === "string") {
    try {
      normalized = JSON.parse(err);
    } catch (_) {
      return err; // Plain non-JSON string — return as-is
    }
  }

  const response = normalized?.response;
  let body = response?.data || response?.body || normalized?.body;
  const statusCode = response?.statusCode || response?.status
    || normalized?.statusCode || normalized?.status;

  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) {}
  }

  let detail = null;

  if (body && typeof body === "object") {
    // 1. Accounting API validation errors (Elements[0].ValidationErrors)
    const elements = body.Elements || body.elements;
    if (Array.isArray(elements) && elements[0]?.ValidationErrors) {
      detail = elements[0].ValidationErrors.map(ve => ve.Message).join("; ");
    } else if (Array.isArray(elements) && elements[0]?.validationErrors) {
      detail = elements[0].validationErrors.map(ve => ve.message).join("; ");
    }

    // 2. Projects API / other top-level keys
    detail = detail || body.Detail || body.detail || body.Message || body.message || body.error;

    // 3. ModelState errors (e.g. model.EstimateAmount)
    if (!detail && body.modelState) {
      detail = Object.values(body.modelState).flat().join("; ");
    }

    if (!detail) detail = JSON.stringify(body);
  }

  const finalMessage = detail
    || (typeof normalized === "object" ? normalized?.message : null)
    || (statusCode ? `HTTP ${statusCode}` : "Xero API Error");

  console.error(`[xeroService] Parsed Error Detail:`, finalMessage);
  if (body) console.log(`[xeroService] Raw Error Body:`, JSON.stringify(body));

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
    // ── Lookup-before-create: only runs when we don't already have a known contact ID ──
    // Skip this when xeroContactId is provided — that means we're on the update path and
    // already know exactly which contact to hit.
    if (!xeroContactId) {
      // 1. Search by account number (most precise — avoids any name ambiguity)
      if (accountNumber) {
        try {
          const searchResp = await xero.accountingApi.getContacts(
            tenantId, undefined, `AccountNumber=="${accountNumber}"`
          );
          const found = searchResp.body?.contacts?.[0];
          if (found?.contactID) {
            console.log(`[xeroService] Found existing Xero contact by AccountNumber "${accountNumber}" → ${found.contactID}`);
            return { contactId: found.contactID, accountNumber: found.accountNumber };
          }
        } catch (_) { /* non-fatal — fall through */ }
      }

      // 2. Search by exact name (fallback)
      if (name) {
        try {
          const safeName = name.replace(/'/g, "''");
          const searchResp = await xero.accountingApi.getContacts(
            tenantId, undefined, `Name=="${safeName}"`
          );
          const found = searchResp.body?.contacts?.find(
            (c) => c.name?.toLowerCase() === name.toLowerCase()
          );
          if (found?.contactID) {
            console.log(`[xeroService] Found existing Xero contact by Name "${name}" → ${found.contactID}`);
            return { contactId: found.contactID, accountNumber: found.accountNumber };
          }
        } catch (_) { /* non-fatal — fall through */ }
      }
    }

    console.log(`[xeroService] Calling createContacts — tenantId=${tenantId} name="${name}"`);
      try {
        const response = await xero.accountingApi.createContacts(tenantId, {
          contacts: [contact],
        });
        const created = response.body?.contacts?.[0];
        return {
          contactId: created?.contactID,
          accountNumber: created?.accountNumber,
        };
      } catch (err) {
        console.error("[xeroService] createContacts threw — typeof:", typeof err, "| constructor:", err?.constructor?.name);
        try {
          console.error("[xeroService] createContacts error dump:", JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})));
        } catch (_) {
          console.error("[xeroService] createContacts error (not serialisable):", String(err));
        }

        // Normalize: xero-node v15 may throw the full response as a JSON string
        let normalized = err;
        if (typeof err === "string") {
          try { normalized = JSON.parse(err); } catch (_) {}
        }
        const errResponse = normalized?.response;
        let errBody = errResponse?.body || errResponse?.data || normalized?.body;
        if (typeof errBody === "string") {
          try { errBody = JSON.parse(errBody); } catch (_) {}
        }
        const status = errResponse?.statusCode || errResponse?.status
          || normalized?.statusCode || normalized?.status
          || err?.response?.statusCode || err?.statusCode || err?.response?.status || err?.status;

        // Recovery: Contact deleted from Xero (404)
        if (xeroContactId && status === 404) {
          console.warn(`[xeroService] Contact ${xeroContactId} not found in Xero. Retrying as new creation.`);
          delete contact.contactID;
          const retryResponse = await xero.accountingApi.createContacts(tenantId, { contacts: [contact] });
          const retried = retryResponse.body?.contacts?.[0];
          return {
            contactId: retried?.contactID,
            accountNumber: retried?.accountNumber,
          };
        }

        const errorDetail = parseXeroError(err);

        // Recovery: Duplicate Account Number (400) — Xero includes the existing ContactID in Elements[0]
        if (status === 400 && errorDetail.toLowerCase().includes("account number already exists")) {
          const elements = Array.isArray(errBody?.Elements) ? errBody.Elements : [];
          const existingContactId = elements[0]?.ContactID;
          if (existingContactId) {
            console.log(`[xeroService] ✓ Duplicate account number resolved → existing ContactID: ${existingContactId}`);
            // Fetch the full contact to get the current account number
            const fetchResp = await xero.accountingApi.getContact(tenantId, existingContactId);
            const found = fetchResp.body?.contacts?.[0];
            return {
              contactId: found?.contactID,
              accountNumber: found?.accountNumber,
            };
          }
          // Fallback: search by account number
          if (accountNumber) {
            console.log(`[xeroService] Searching for contact by account number "${accountNumber}"…`);
            const searchResp = await xero.accountingApi.getContacts(tenantId, undefined, `AccountNumber=="${accountNumber}"`);
            const found = searchResp.body?.contacts?.[0];
            if (found?.contactID) {
              console.log(`[xeroService] ✓ Found contact by account number: ${found.contactID}`);
              return {
                contactId: found.contactID,
                accountNumber: found.accountNumber,
              };
            }
          }
        }

        // Recovery: Duplicate Contact Name (400)
        if (status === 400 && errorDetail.toLowerCase().includes("already assigned to another contact")) {
          console.log(`[xeroService] Duplicate name detected for "${name}". Searching for existing contact…`);
          const safeName = name.replace(/'/g, "''");
          const searchResponse = await xero.accountingApi.getContacts(tenantId, undefined, `Name=="${safeName}"`);
          const existing = searchResponse.body?.contacts?.find(c => c.name?.toLowerCase() === name.toLowerCase());
          if (existing) {
            console.log(`[xeroService] ✓ Conflict resolved. Found existing contactId: ${existing.contactID}`);
            return {
              contactId: existing.contactID,
              accountNumber: existing.accountNumber,
            };
          } else {
            console.warn(`[xeroService] Conflict reported by Xero but search returned no match for "${name}"`);
          }
        }

        throw err;
      }
  };

  // 20s Timeout Guard (covers up to 2 lookup calls + 1 create call)
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("TIMEOUT: Xero API took longer than 20s")), 20000);
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

/**
 * Pushes a Labor cost to a Xero Project as a Time Entry.
 * Xero requires a taskId on every time entry — we create a TIME-type task first.
 */
async function createProjectTimeEntry({ xeroProjectId, description, hours, rate, date }) {
  console.log(`[xeroService] createProjectTimeEntry — projectId=${xeroProjectId} hours=${hours} rate=${rate}`);

  const durationMinutes = Math.round((parseFloat(hours) || 0) * 60);
  if (durationMinutes < 1) {
    console.warn(`[xeroService] Skipping time entry — duration ${durationMinutes} min is below minimum (1 min).`);
    return null;
  }

  const { xero, tenantId } = await getAuthenticatedClient();

  try {
    // Step 1: create a TIME task to satisfy the required taskId field.
    // The task rate drives what Xero shows as the cost (hours × rate).
    const taskResponse = await xero.projectApi.createTask(tenantId, xeroProjectId, {
      name: description || "Labor",
      rate: { value: parseFloat(rate) || 0, currency: "USD" },
      chargeType: "TIME",
    });
    const taskId = taskResponse.body?.taskId;
    if (!taskId) throw new Error("Xero createTask returned no taskId for time entry.");

    // Step 2: get a project user to attribute the time to
    const usersResponse = await xero.projectApi.getProjectUsers(tenantId);
    const xeroUserId = usersResponse.body?.items?.[0]?.userId;
    if (!xeroUserId) throw new Error("No active users found in Xero Projects to attribute time to.");

    // Step 3: create the time entry
    const response = await xero.projectApi.createTimeEntry(tenantId, xeroProjectId, {
      userId: xeroUserId,
      taskId,
      dateUtc: new Date(date),
      duration: durationMinutes,
      description: description || "Labor",
    });

    const timeEntryId = response.body?.timeEntryId;
    console.log(`[xeroService] ✓ Time Entry created — timeEntryId=${timeEntryId} taskId=${taskId}`);
    // Return taskId (not timeEntryId) — deleting the task removes the task + all its time entries,
    // preventing orphaned TIME tasks that show up as ghost entries in Xero.
    return taskId;
  } catch (err) {
    const detail = parseXeroError(err);
    throw new Error(`Xero createTimeEntry failed: ${detail}`);
  }
}

/**
 * Pushes a Part/Expense cost to a Xero Project as a Project Expense.
 */
async function createProjectExpense({ xeroProjectId, description, amount, date }) {
  console.log(`[xeroService] createProjectExpense — projectId=${xeroProjectId} amount=${amount}`);

  const { xero, tenantId } = await getAuthenticatedClient();

  try {
    const response = await xero.projectApi.createTask(tenantId, xeroProjectId, {
      name: description,
      rate: { value: amount, currency: "USD" },
      chargeType: "FIXED",
    });
    const taskId = response.body?.taskId;
    console.log(`[xeroService] ✓ Project Task (fixed expense) created — taskId=${taskId}`);
    return taskId || null;
  } catch (err) {
    const detail = parseXeroError(err);
    throw new Error(`Xero createTask failed: ${detail}`);
  }
}

/**
 * Deletes a Time Entry from a Xero Project.
 */
async function deleteProjectTimeEntry(xeroProjectId, timeEntryId) {
  console.log(`[xeroService] deleteProjectTimeEntry — projectId=${xeroProjectId} timeEntryId=${timeEntryId}`);
  const { xero, tenantId } = await getAuthenticatedClient();
  try {
    await xero.projectApi.deleteTimeEntry(tenantId, xeroProjectId, timeEntryId);
    console.log(`[xeroService] ✓ Time Entry deleted — timeEntryId=${timeEntryId}`);
  } catch (err) {
    const detail = parseXeroError(err);
    throw new Error(`Xero deleteTimeEntry failed: ${detail}`);
  }
}

/**
 * Deletes a Task (fixed expense) from a Xero Project.
 */
async function deleteProjectTask(xeroProjectId, taskId) {
  console.log(`[xeroService] deleteProjectTask — projectId=${xeroProjectId} taskId=${taskId}`);
  const { xero, tenantId } = await getAuthenticatedClient();
  try {
    await xero.projectApi.deleteTask(tenantId, xeroProjectId, taskId);
    console.log(`[xeroService] ✓ Task deleted — taskId=${taskId}`);
  } catch (err) {
    const detail = parseXeroError(err);
    throw new Error(`Xero deleteTask failed: ${detail}`);
  }
}

/**
 * Updates a Labor TIME task in place: updates the task rate/name AND the
 * linked time entry's duration — no deletion required.
 * Xero disables/blocks task deletion when time entries exist, so delete-then-
 * recreate is not a viable update strategy for Labor entries.
 *
 * Returns the same taskId (unchanged) so the stored xeroSyncId stays valid.
 */
async function updateLaborTaskInPlace(xeroProjectId, taskId, { description, hours, rate, date }) {
  console.log(`[xeroService] updateLaborTaskInPlace — projectId=${xeroProjectId} taskId=${taskId}`);
  const { xero, tenantId } = await getAuthenticatedClient();
  const durationMinutes = Math.round((parseFloat(hours) || 0) * 60);

  // 1. Update the task: name and hourly rate
  try {
    await xero.projectApi.updateTask(tenantId, xeroProjectId, taskId, {
      name: description || "Labor",
      rate: { value: parseFloat(rate) || 0, currency: "USD" },
      chargeType: "TIME",
    });
    console.log(`[xeroService] ✓ Task rate/name updated — taskId=${taskId}`);
  } catch (err) {
    throw new Error(`Xero updateTask failed: ${parseXeroError(err)}`);
  }

  // 2. Find the time entry linked to this task and update its duration
  try {
    const teResponse = await xero.projectApi.getTimeEntries(tenantId, xeroProjectId);
    const linked = (teResponse.body?.items || []).filter(te => te.taskId === taskId);

    if (linked.length > 0) {
      // Update the first (and normally only) time entry for this task
      await xero.projectApi.updateTimeEntry(tenantId, xeroProjectId, linked[0].timeEntryId, {
        userId:      linked[0].userId,
        taskId,
        duration:    durationMinutes,
        description: description || "Labor",
        dateUtc:     new Date(date),
      });
      console.log(`[xeroService] ✓ Time entry duration updated — timeEntryId=${linked[0].timeEntryId}`);
    } else {
      console.warn(`[xeroService] No time entry found for task ${taskId} — duration not updated`);
    }
  } catch (err) {
    // Non-fatal: task rate was already updated; log and continue
    console.warn(`[xeroService] Could not update time entry for task ${taskId}:`, parseXeroError(err));
  }

  return taskId; // taskId is unchanged — stored xeroSyncId remains valid
}

/**
 * Deletes a Xero Project entry by its XERO_SYNC_ID.
 * Both Labor (TIME task) and Parts/Expense (FIXED task) entries store a taskId.
 * Accepts bare UUIDs (new format) or legacy "TIME:uuid"/"TASK:uuid" prefixed values.
 */
async function deleteXeroSyncEntry(xeroProjectId, xeroSyncId) {
  if (!xeroSyncId || xeroSyncId.startsWith("synced-")) return;
  // Strip legacy prefix if present (e.g. "TIME:uuid" → "uuid")
  const taskId = xeroSyncId.includes(":") ? xeroSyncId.split(":")[1] : xeroSyncId;
  await deleteProjectTask(xeroProjectId, taskId);
}

/**
 * Updates a Time Entry in a Xero Project.
 */
async function updateProjectTimeEntry(xeroProjectId, timeEntryId, { description, hours, rate, date }) {
  console.log(`[xeroService] updateProjectTimeEntry — projectId=${xeroProjectId} timeEntryId=${timeEntryId}`);
  const { xero, tenantId } = await getAuthenticatedClient();
  const durationMinutes = Math.round((parseFloat(hours) || 0) * 60);
  
  try {
    await xero.projectApi.updateTimeEntry(tenantId, xeroProjectId, timeEntryId, {
      description,
      duration: durationMinutes,
      dateUtc: new Date(date),
    });
    console.log(`[xeroService] ✓ Time Entry updated — timeEntryId=${timeEntryId}`);
  } catch (err) {
    const detail = parseXeroError(err);
    throw new Error(`Xero updateTimeEntry failed: ${detail}`);
  }
}

/**
 * Updates a Task (fixed expense) in a Xero Project.
 */
async function updateProjectTask(xeroProjectId, taskId, { description, amount }) {
  console.log(`[xeroService] updateProjectTask — projectId=${xeroProjectId} taskId=${taskId}`);
  const { xero, tenantId } = await getAuthenticatedClient();
  try {
    await xero.projectApi.updateTask(tenantId, xeroProjectId, taskId, {
      name: description,
      rate: { value: amount, currency: "USD" },
      chargeType: "FIXED",
    });
    console.log(`[xeroService] ✓ Task updated — taskId=${taskId}`);
  } catch (err) {
    const detail = parseXeroError(err);
    throw new Error(`Xero updateTask failed: ${detail}`);
  }
}

/**
 * Unified sync function for a Master Cost item to a Xero Project.
 * Handles Create vs Update based on existingXeroSyncId.
 * Includes locking to prevent duplicates from race conditions.
 */
async function syncMasterCostItemToXero({
  xeroProjectId,
  existingXeroSyncId,
  type,
  description,
  quantity,
  rate,
  totalCost,
  date,
}) {
  const isLabor = type === "Labor";
  const hours = parseFloat(quantity) || 1;
  const amount = parseFloat(totalCost) || parseFloat(quantity || 1) * parseFloat(rate || 0);

  // Strip legacy "TIME:"/"TASK:" prefix from stored value if present
  const existingTaskId = existingXeroSyncId?.includes(":")
    ? existingXeroSyncId.split(":")[1]
    : existingXeroSyncId;

  // 1. UPDATE flow — route by `type`, not stored prefix
  if (existingTaskId && !existingTaskId.startsWith("synced-")) {
    try {
      if (isLabor) {
        // Update in place: update task rate/name + time entry duration.
        // Xero blocks deletion of tasks that have time entries (greyed-out Delete
        // in the UI; same constraint enforced by the API), so delete-then-recreate
        // is not viable — it causes the create to run without the delete, producing
        // a duplicate entry.
        return await updateLaborTaskInPlace(xeroProjectId, existingTaskId, { description, hours, rate, date });
      } else {
        // Direct update for Parts/Expense
        await updateProjectTask(xeroProjectId, existingTaskId, { description, amount });
        return existingTaskId;
      }
    } catch (err) {
      // Only fall back to creation if Xero says the task no longer exists (deleted manually in Xero).
      // For any other failure, rethrow — silently creating a new entry would leave the old task
      // as a stale duplicate and orphan the stored xeroSyncId.
      const msg = String(err?.message || "").toLowerCase();
      const isNotFound = msg.includes("404") || msg.includes("not found") || msg.includes("does not exist");
      if (!isNotFound) {
        throw err;
      }
      console.warn(`[xeroService] Task ${existingTaskId} not found in Xero (404) — will recreate`);
    }
  }

  // 2. CREATE flow — return bare UUID (no prefix)
  if (isLabor) {
    const taskId = await createProjectTimeEntry({
      xeroProjectId,
      description: description || "Labor",
      hours,
      rate: parseFloat(rate) || 0,
      date: date || new Date().toISOString().split("T")[0],
    });
    return taskId || null;
  } else {
    const taskId = await createProjectExpense({
      xeroProjectId,
      description: description || type,
      amount,
      date: date || new Date().toISOString().split("T")[0],
    });
    return taskId || null;
  }
}

/**
 * Creates a draft invoice (ACCREC) in Xero for a Work Order.
 *
 * @param {object} params
 * @param {string} params.xeroContactId  - Xero Contact UUID for the customer
 * @param {string} params.reference      - e.g. "WO-1042"
 * @param {Array}  params.lineItems      - [{ description, quantity, unitPrice, type }]
 * @param {Date}   [params.dueDate]      - Invoice due date (default: 30 days from now)
 *
 * @returns {{ invoiceId: string, invoiceNumber: string, invoiceUrl: string }}
 */
async function createXeroInvoice({ xeroContactId, reference, lineItems, dueDate }) {
  console.log(`[xeroService] createXeroInvoice — contact=${xeroContactId} ref=${reference} items=${lineItems.length}`);

  const { xero, tenantId } = await getAuthenticatedClient();

  const due = dueDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Net 30

  // Map account codes by line item type so revenue is categorised correctly in Xero.
  // Defaults to 200 (Sales) if no matching code; override these to match your Xero
  // chart of accounts.
  const ACCOUNT_CODES = { Labor: "200", Parts: "200", Expense: "200" };

  const xeroLineItems = lineItems.map((item) => ({
    description: item.description || item.type,
    quantity:    parseFloat(item.quantity) || 1,
    unitAmount:  parseFloat(item.unitPrice) || 0,
    accountCode: ACCOUNT_CODES[item.type] || "200",
  }));

  let response;
  try {
    response = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [{
        type:      "ACCREC",
        contact:   { contactID: xeroContactId },
        lineItems: xeroLineItems,
        date:      new Date(),
        dueDate:   due,
        reference,
        status:    "DRAFT",
      }],
    });
  } catch (err) {
    throw new Error(`Xero createInvoice failed: ${parseXeroError(err)}`);
  }

  const inv = response.body?.invoices?.[0];
  if (!inv?.invoiceID) {
    throw new Error("Xero createInvoice returned no invoiceID.");
  }

  console.log(`[xeroService] ✓ Xero Invoice created — invoiceID=${inv.invoiceID} number=${inv.invoiceNumber}`);
  return {
    invoiceId:     inv.invoiceID,
    invoiceNumber: inv.invoiceNumber || "",
    invoiceUrl:    `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${inv.invoiceID}`,
  };
}

module.exports = {
  createXeroProject,
  updateXeroProjectStatus,
  createXeroContact,
  createProjectTimeEntry,
  createProjectExpense,
  deleteProjectTimeEntry,
  deleteProjectTask,
  deleteXeroSyncEntry,
  syncMasterCostItemToXero,
  createXeroInvoice,
  tryAcquireSyncLock,
  releaseSyncLock,
  getAuthenticatedClient,
  XERO_SCOPES,
  buildXeroClient,
};
