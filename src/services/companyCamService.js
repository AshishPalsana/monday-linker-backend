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

module.exports = {
  createProject,
  createProjectReport,
};
