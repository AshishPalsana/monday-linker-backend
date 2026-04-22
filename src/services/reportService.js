const prisma = require("../lib/prisma");
const { getCSTDayBounds } = require("../lib/cstTime");

/**
 * Compiles all narratives and activity from today into a single report.
 * @param {string} date - Optional YYYY-MM-DD
 */
async function generateDailyNarrativeReport(date) {
  const { dayStart, dayEnd } = getCSTDayBounds(date);

  const entries = await prisma.timeEntry.findMany({
    where: {
      clockIn: { gte: dayStart, lte: dayEnd },
      entryType: { in: ["Job", "NonJob"] },
      status: "Complete",
    },
    include: {
      technician: true,
    },
    orderBy: { technicianId: "asc" },
  });

  if (entries.length === 0) {
    return "No activity recorded for today.";
  }

  let report = `Daily Activity Report - ${date || new Date().toLocaleDateString()}\n`;
  report += "=".repeat(40) + "\n\n";

  let currentTechId = null;

  for (const entry of entries) {
    if (entry.technicianId !== currentTechId) {
      report += `\nTECHNICIAN: ${entry.technician.name}\n`;
      report += "-".repeat(20) + "\n";
      currentTechId = entry.technicianId;
    }

    const type = entry.entryType === "Job" ? `Job (${entry.workOrderLabel})` : `Task (${entry.taskCategory})`;
    report += `[${entry.clockIn.toLocaleTimeString()}] ${type}\n`;
    report += `Location: ${entry.jobLocation || "N/A"}\n`;
    report += `Narrative: ${entry.narrative || "No notes provided."}\n`;
    report += `Hours: ${entry.hoursWorked}\n\n`;
  }

  return report;
}

module.exports = {
  generateDailyNarrativeReport,
};
