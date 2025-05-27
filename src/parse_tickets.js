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

  // Map global fees for easier lookup (from root-level fees array)
  const rootFeeMap = {};
  if (axsResults.price && axsResults.price.fees && Array.isArray(axsResults.price.fees)) {
    for (const fee of axsResults.price.fees) {
      rootFeeMap[fee.id] = fee; // Use fee.id for lookup
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
                continue;
              }

              const priceLevelData = {
                priceLevelID: priceLevel.priceLevelID,
                label: priceLevel.label,
                basePrice: 0, // Base Component
                facilityFee: 0, // VEN_FacFee
                totalFees: 0, // All applicable PER-ITEM fees from root-level
                totalTax: 0, // Calculated tax
                websiteDisplayPrice: 0, // This will be the full calculated price for a single ticket
              };

              const firstPriceEntry = priceLevel.prices[0];
              const baseAmountForFeeCalculation = firstPriceEntry.base; // e.g., 19950 for PL1 (Base Component + VEN_FacFee)

              let baseComponentAmount = 0;
              let venFacFeeAmount = 0;
              let currentTaxableAmount = 0; // Amount on which tax is applied (before taxes are calculated)

              const priceComponents = firstPriceEntry.priceComponents;
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

              let totalCalculatedPerItemFees = 0; // Sum of all PER-ITEM fees

              // --- Process root-level fees that are assigned to this offer ---
              if (offerPrice.fees && Array.isArray(offerPrice.fees)) {
                for (const offerAssignedFee of offerPrice.fees) {
                  const feeDef = rootFeeMap[offerAssignedFee.id]; // Get the full fee definition from rootFeeMap

                  if (feeDef && feeDef.components && Array.isArray(feeDef.components)) {
                    // Only process fees with applicationMethod "PerItem" for totalCalculatedPerItemFees
                    if (feeDef.applicationMethod === "PerItem") {
                      for (const component of feeDef.components) {
                        let feeComponentAmount = 0;
                        const priceInDollars = baseAmountForFeeCalculation / 100; // Convert to dollars for lookup ranges

                        if (component.calculationMethod === "Lookup" && Array.isArray(component.lookupRanges)) {
                          // Find the correct amount based on the base price (in dollars)
                          for (const range of component.lookupRanges) {
                            // Handle the case where end is 0 for the last range (e.g., ">301")
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
                        } else if (component.calculationMethod === "Fixed" && typeof component.amount === 'number') {
                          feeComponentAmount = component.amount;
                        }

                        totalCalculatedPerItemFees += feeComponentAmount;

                        // If this fee component is taxable, add its amount to the taxable sum
                        if (component.taxIds && component.taxIds.includes("1001")) { // Check for taxId '1001' (LET)
                          currentTaxableAmount += feeComponentAmount;
                        }
                      }
                    }
                  }
                }
              }

              priceLevelData.totalFees = totalCalculatedPerItemFees; // This now only includes PerItem fees

              // --- Calculate Total Tax ---
              let globalTaxRate = 0;
              const letTaxDef = taxMap["1001"]; // Get the 'LET' tax definition
              if (letTaxDef) {
                globalTaxRate = letTaxDef.rate;
              }

              priceLevelData.totalTax = (currentTaxableAmount * globalTaxRate) / 100;

              // --- Calculate Website Display Price ---
              // websiteDisplayPrice = (Base Component + VEN_FacFee) + total_calculated_per_item_fees + total_tax
              priceLevelData.websiteDisplayPrice = baseAmountForFeeCalculation + totalCalculatedPerItemFees + priceLevelData.totalTax;


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

    // If we have detailed offer data, process that for specific seats
    if (axsResults.offerSearch && axsResults.offerSearch.offers) {

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
        const groupData = sectionRowPriceSeats[key];
        const priceLevelData = priceLevelsMap[groupData.priceLevelId];
        
        if (!priceLevelData) {
          console.warn(`Price level data not found for ID: ${groupData.priceLevelId}. Skipping seats.`);
          continue;
        }

        // Sort seats by number
        groupData.seats.sort((a, b) => a.number - b.number);

        // Find consecutive groups
        const consecutiveGroups = [];
        let currentGroup = [groupData.seats[0]];

        for (let i = 1; i < groupData.seats.length; i++) {
          const currentSeat = groupData.seats[i];
          const previousSeat = groupData.seats[i - 1];

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
        for (const seatGroup of consecutiveGroups) {
          // Process groups of 2-4 seats
          if (seatGroup.length >= 2) {
            // Take up to 4 seats
            const selectedSeats = seatGroup.slice(0, Math.min(4, seatGroup.length));
            // Calculate prices
            const face_price = priceLevelData.basePrice / 100;
            const taxed_cost = (priceLevelData.totalFees + priceLevelData.totalTax) / 100;
            const cost = face_price + taxed_cost;

            tickets.push({
              section: groupData.sectionLabel,
              row: groupData.rowLabel,
              seats: selectedSeats.map(s => s.number).join(','),
              quantity: selectedSeats.length,
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