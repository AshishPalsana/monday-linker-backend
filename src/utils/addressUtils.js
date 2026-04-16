/**
 * Combines structured address fields into a single string for Monday.com.
 * Format: Address Line 1, Address Line 2, City, State ZIP, Country
 * 
 * @param {object} fields 
 * @returns {string}
 */
function combineAddress({
  addressLine1,
  addressLine2,
  city,
  state,
  zip,
  country
}) {
  const parts = [];
  
  if (addressLine1) parts.push(addressLine1.trim());
  if (addressLine2) parts.push(addressLine2.trim());
  if (city) parts.push(city.trim());
  
  let stateZip = "";
  if (state) stateZip += state.trim();
  if (zip) stateZip += (stateZip ? " " : "") + zip.trim();
  if (stateZip) parts.push(stateZip);
  
  if (country) parts.push(country.trim());
  
  return parts.filter(p => !!p).join(", ");
}

/**
 * Basic parser to extract structured fields from a combined string.
 * This is a "best effort" heuristic for the migration.
 * 
 * @param {string} combined 
 * @returns {object}
 */
function parseAddressHeuristic(combined) {
  if (!combined) return {};
  
  const parts = combined.split(",").map(p => p.trim());
  
  // Very basic mapping for Common US format: [Line1, City, State Zip, Country]
  // or [Line1, Line2, City, State Zip, Country]
  if (parts.length >= 5) {
    return {
      addressLine1: parts[0],
      addressLine2: parts[1],
      city: parts[2],
      state: parts[3].split(" ")[0],
      zip: parts[3].split(" ").slice(1).join(" "),
      country: parts[4]
    };
  }
  
  if (parts.length === 4) {
    return {
      addressLine1: parts[0],
      city: parts[1],
      state: parts[2].split(" ")[0],
      zip: parts[2].split(" ").slice(1).join(" "),
      country: parts[3]
    };
  }

  // Fallback: just put it in Line 1
  return { addressLine1: combined };
}

module.exports = {
  combineAddress,
  parseAddressHeuristic
};
