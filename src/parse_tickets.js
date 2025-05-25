import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Helper function to build a map of price levels with their calculated pricing.
 * @param {Object} axsResults Object containing price data.
 * @returns {Object} Map of priceLevelID to price data.
 */
function buildPriceLevelsMap(axsResults) {
  const priceLevelsMap = {};
  console.log('Building price levels map...');

  // Map global fees for easier lookup (from root-level fees array)
  const rootFeeMap = {};
  if (axsResults.price && axsResults.price.fees && Array.isArray(axsResults.price.fees)) {
    for (const fee of axsResults.price.fees) {
      rootFeeMap[fee.name] = fee;
    }
  }

  // Map global taxes for easier lookup
  const taxMap = {};
  if (axsResults.price && axsResults.price.taxes && Array.isArray(axsResults.price.taxes)) {
    for (const tax of axsResults.price.taxes) {
      taxMap[tax.id] = tax;
    }
  }

  if (axsResults.price && axsResults.price.offerPrices) {
    for (const offerPrice of axsResults.price.offerPrices) {
      if (offerPrice.zonePrices) {
        for (const zonePrice of offerPrice.zonePrices) {
          if (zonePrice.priceLevels) {
            for (const priceLevel of zonePrice.priceLevels) {
              if (!priceLevel.prices || priceLevel.prices.length === 0) {
                console.warn(`Price level ${priceLevel.label} (${priceLevel.priceLevelID}) has no detailed prices. Skipping.`);
                continue;
              }

              const priceLevelData = {
                priceLevelID: priceLevel.priceLevelID,
                label: priceLevel.label,
                basePrice: 0, // Base Component
                facilityFee: 0, // VEN_FacFee
                totalFees: 0, // All applicable fees from root-level
                totalTax: 0, // Calculated tax
                websiteDisplayPrice: 0,
              };

              // The 'base' field at priceLevel.prices[0] seems to be Base Component + VEN_FacFee
              // This is the amount *before* the root-level fees and taxes are applied to it.
              const baseAmountForFeeCalculation = priceLevel.prices[0].base; // e.g., 19950 for PL1

              // Extract individual price components and identify their taxability
              let baseComponentAmount = 0;
              let venFacFeeAmount = 0;
              let currentTaxableAmount = 0; // Amount on which tax is applied

              const priceComponents = priceLevel.prices[0].priceComponents;
              if (priceComponents) {
                for (const comp of priceComponents) {
                  if (comp.name === "Base Component") {
                    baseComponentAmount = comp.amount;
                  } else if (comp.name === "VEN_FacFee") {
                    venFacFeeAmount = comp.amount;
                  }
                  // If this price component is taxable, add its amount to the taxable sum
                  if (comp.taxIds && comp.taxIds.includes("1001")) { // Check for taxId '1001' (LET)
                    currentTaxableAmount += comp.amount;
                  }
                }
              }

              priceLevelData.basePrice = baseComponentAmount;
              priceLevelData.facilityFee = venFacFeeAmount;

              let totalCalculatedFees = 0; // Sum of all fees (service, convenience, order processing from root-level)

              // --- Process root-level fees ---
              for (const feeName in rootFeeMap) {
                const feeDef = rootFeeMap[feeName];
                // Check if this fee definition applies to the current offer (offerID) or offerGroupID
                // For simplicity, let's assume it applies to all for now as the 'assignments' array is complex.
                // Or, more accurately, we'd need to link offerPrice.offerID to fee.assignments.associatedWith.
                // Given the user's observed "Actual Price" includes these fees, they are likely universally applied or apply to 'Regular' offer.
                // Let's iterate through its components
                if (feeDef.components && Array.isArray(feeDef.components)) {
                  for (const component of feeDef.components) {
                    let feeComponentAmount = 0;
                    const priceInDollars = baseAmountForFeeCalculation / 100; // Convert to dollars for lookup ranges

                    if (component.calculationMethod === "Lookup" && Array.isArray(component.lookupRanges)) {
                      // Find the correct amount based on the base price (in dollars)
                      for (const range of component.lookupRanges) {
                        if (priceInDollars >= range.start && (range.end === 0 || priceInDollars < range.end)) {
                          feeComponentAmount = range.amount;
                          break;
                        }
                      }
                    } else if (component.calculationMethod === "Percentage" && typeof component.rate === 'number') {
                      feeComponentAmount = (baseAmountForFeeCalculation * component.rate) / 100;
                      if (typeof component.roundOff === 'number') {
                        feeComponentAmount = Math.round(feeComponentAmount / component.roundOff) * component.roundOff;
                      }
                    }

                    totalCalculatedFees += feeComponentAmount;

                    // If this fee component is taxable, add its amount to the taxable sum
                    if (component.taxIds && component.taxIds.includes("1001")) { // Check for taxId '1001' (LET)
                      currentTaxableAmount += feeComponentAmount;
                    }
                  }
                }
              }

              priceLevelData.totalFees = totalCalculatedFees;

              // --- Calculate Total Tax ---
              let globalTaxRate = 0;
              const letTaxDef = taxMap["1001"]; // Get the 'LET' tax definition
              if (letTaxDef) {
                globalTaxRate = letTaxDef.rate;
              }

              priceLevelData.totalTax = (currentTaxableAmount * globalTaxRate) / 100;

              // --- Calculate Website Display Price ---
              // websiteDisplayPrice = (Base Component + VEN_FacFee) + total_calculated_fees + total_tax
              priceLevelData.websiteDisplayPrice = baseAmountForFeeCalculation + totalCalculatedFees + priceLevelData.totalTax;


              console.log(`Price Level ${priceLevel.label} (${priceLevel.priceLevelID}):`);
              console.log(`  Base + Fac Fee: $${(baseAmountForFeeCalculation / 100).toFixed(2)}`);
              console.log(`  Calculated Fees: $${(totalCalculatedFees / 100).toFixed(2)}`);
              console.log(`  Taxable Amount: $${(currentTaxableAmount / 100).toFixed(2)}`);
              console.log(`  Total Tax: $${(priceLevelData.totalTax / 100).toFixed(2)} (at ${globalTaxRate}%)`);
              console.log(`  Website Display Price: $${(priceLevelData.websiteDisplayPrice / 100).toFixed(2)}`);

              priceLevelsMap[priceLevel.priceLevelID] = priceLevelData;
            }
          }
        }
      }
    }
  }

  return priceLevelsMap;
}

/**
 * Parse AXS ticket data from the provided data object
 * @param {Object} axsResults Object containing sections, offerSearch, and price data
 * @returns {Promise<Array>} Array of ticket objects
 */
async function parseAXSTickets(axsResults) {
  try {
    console.log('Parsing ticket data from provided object');

    // Initialize tickets array
    const tickets = [];

    // Build price level mapping with accurate pricing
    const priceLevelsMap = buildPriceLevelsMap(axsResults);
    console.log(`Found ${Object.keys(priceLevelsMap).length} price levels in price data`);

    // If we have detailed offer data, process that for specific seats
    if (axsResults.offerSearch && axsResults.offerSearch.offers) {
      console.log(`Processing ${axsResults.offerSearch.offers.length} offers with detailed seat information...`);

      // Group seats by section, row, and price level
      const sectionRowPriceSeats = {};

      // First pass: Collect all valid seats
      for (const offer of axsResults.offerSearch.offers) {
        if (!offer.items || !Array.isArray(offer.items) || offer.items.length === 0) {
          continue;
        }

        for (const item of offer.items) {
          // Skip if not available or if it's accessible/restricted view
          if (item.statusCodeLabel !== "Available" || 
              item.attributes?.some(attr => 
                attr.toLowerCase().includes('restricted') || 
                attr.toLowerCase().includes('accessible')
              )) {
            continue;
          }

          const key = `${item.sectionID}-${item.rowLabel}-${item.priceLevelID}`;
          
          if (!sectionRowPriceSeats[key]) {
            sectionRowPriceSeats[key] = {
              sectionLabel: item.sectionLabel,
              rowLabel: item.rowLabel,
              priceLevelId: item.priceLevelID,
              seats: []
            };
          }

          sectionRowPriceSeats[key].seats.push({
            number: parseInt(item.number),
            offerId: offer.offerID
          });
        }
      }

      // Second pass: Process each section-row group to find valid pairs
      for (const key in sectionRowPriceSeats) {
        const group = sectionRowPriceSeats[key];
        const priceLevelData = priceLevelsMap[group.priceLevelId];
        
        if (!priceLevelData) {
          console.warn(`Price level data not found for ID: ${group.priceLevelId}. Skipping seats.`);
          continue;
        }

        // Sort seats by number
        group.seats.sort((a, b) => a.number - b.number);

        // Find consecutive groups
        const consecutiveGroups = [];
        let currentGroup = [group.seats[0]];

        for (let i = 1; i < group.seats.length; i++) {
          const currentSeat = group.seats[i];
          const previousSeat = group.seats[i - 1];

          if (currentSeat.number === previousSeat.number + 1) {
            // Seat is consecutive
            currentGroup.push(currentSeat);
          } else {
            // Break in consecutive seats
            if (currentGroup.length >= 2) {
              consecutiveGroups.push([...currentGroup]);
            }
            currentGroup = [currentSeat];
          }
        }

        // Add the last group if it's valid
        if (currentGroup.length >= 2) {
          consecutiveGroups.push(currentGroup);
        }

        // Process consecutive groups
        for (const group of consecutiveGroups) {
          // Process groups of 2-4 seats
          if (group.length >= 2) {
            // Take up to 4 seats
            const seatGroup = group.slice(0, Math.min(4, group.length));
            // Calculate prices
            const face_price = priceLevelData.basePrice / 100;
            const taxed_cost = (priceLevelData.totalFees + priceLevelData.totalTax) / 100;
            const cost = face_price + taxed_cost;

            tickets.push({
              section: group.sectionLabel,
              row: group.rowLabel,
              seats: seatGroup.map(s => s.number).join(','),
              quantity: seatGroup.length,
              face_price: parseFloat(face_price.toFixed(2)),
              taxed_cost: parseFloat(taxed_cost.toFixed(2)),
              cost: parseFloat(cost.toFixed(2))
            });
          }
        }
      }
    }

    console.log(`Finished parsing. Total tickets generated: ${tickets.length}`);
    return tickets;

  } catch (error) {
    console.error('Error during ticket parsing:', error);
    throw error;
  }
}

// Export only the parseAXSTickets function
export { parseAXSTickets };