const axios = require("axios");

const CC_API_URL = "https://api.companycam.com/v2";

function getClient() {
  const token = process.env.COMPANYCAM_API_TOKEN;
  if (!token) {
    console.warn("[companyCamService] COMPANYCAM_API_TOKEN is not set.");
    return null;
  }
  return axios.create({
    baseURL: CC_API_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 * Creates a Project (Location) in CompanyCam
 */
async function createProject({ name, address, city, state, zip }) {
  const client = getClient();
  if (!client) return null;

  try {
    const response = await client.post("/projects", {
      name,
      address: {
        street_address_1: address || undefined,
        city: city || undefined,
        state: state || undefined,
        postal_code: zip || undefined,
      }
    });
    console.log(`[companyCamService] Created project: ${response.data.id}`);
    return response.data;
  } catch (err) {
    const errorBody = err.response?.data;
    console.error("[companyCamService] Error creating project:", errorBody || err.message);
    throw new Error(errorBody?.errors?.[0]?.message || err.message);
  }
}

/**
 * Creates a blank Report under a project
 */
async function createProjectReport(projectId, { title }) {
  const client = getClient();
  if (!client) return null;

  try {
    console.log(`[companyCamService] Creating report "${title}" for project ${projectId}...`);
    
    // Per CC API: POST /reports requires project_id and title
    const response = await client.post(`/reports`, {
      project_id: projectId,
      title: title
    });

    console.log(`[companyCamService] ✓ Report created: ${response.data.id}`);
    return response.data;
  } catch (err) {
    const errorBody = err.response?.data;
    console.error("[companyCamService] Error creating report:", errorBody || err.message);
    throw new Error(errorBody?.errors?.[0]?.message || err.message);
  }
}

/**
 * Centralized logic to sync a Monday Location item to CompanyCam.
 * To be used by both webhooks and direct API calls.
 */
async function syncLocation(pulseId) {
  const prisma = require("../lib/prisma");
  const { getLocationDetails } = require("../lib/mondayClient");

  console.log(`[companyCamService] syncLocation triggered for pulse ${pulseId}`);

  try {
    // 1. Fetch location details from Monday
    const loc = await getLocationDetails(pulseId);
    if (!loc) {
      console.warn(`[companyCamService] Could not fetch details for item ${pulseId}. Skipping sync.`);
      return null;
    }

    // 2. Check if already synced in our DB
    let mapping = await prisma.locationSync.findUnique({
      where: { mondayItemId: String(pulseId) }
    });

    if (mapping && mapping.companyCamProjectId) {
      console.log(`[companyCamService] Item ${pulseId} already has CompanyCam Project ${mapping.companyCamProjectId}. Skipping re-creation.`);
      return mapping.companyCamProjectId;
    }

    // 3. Create Project in CompanyCam
    const ccProject = await createProject({
      name: loc.name,
      address: loc.streetAddress,
      city: loc.city,
      state: loc.state,
      zip: loc.zip
    });

    if (ccProject && ccProject.id) {
      // 4. Save mapping in DB
      mapping = await prisma.locationSync.upsert({
        where: { mondayItemId: String(pulseId) },
        update: { companyCamProjectId: String(ccProject.id) },
        create: {
          mondayItemId: String(pulseId),
          companyCamProjectId: String(ccProject.id)
        }
      });
      console.log(`[companyCamService] ✓ Item ${pulseId} synced to CompanyCam Project ${ccProject.id}`);
      return ccProject.id;
    } else {
      throw new Error("CompanyCam Project creation returned no ID.");
    }

  } catch (err) {
    console.error(`[companyCamService] ✗ syncLocation failed for pulse ${pulseId}:`, err.message);
    throw err;
  }
}

module.exports = {
  createProject,
  createProjectReport,
  syncLocation,
};
