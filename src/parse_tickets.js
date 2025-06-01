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
                priceTypeID: null, // Store priceTypeID for dynamic pricing lookup
                rawDynamicPrices: zonePrice.rawDynamicPrices || {}, // Store dynamic prices for this zone
              };

              const firstPriceEntry = priceLevel.prices[0];
              const baseAmountForFeeCalculation = firstPriceEntry.base; // e.g., 19950 for PL1 (Base Component + VEN_FacFee)
              
              // Store the priceTypeID from the first price entry
              priceLevelData.priceTypeID = firstPriceEntry.priceTypeID;

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
 * Helper function to get dynamic price for a specific seat
 * @param {Object} priceLevelData Price level data containing rawDynamicPrices
 * @param {string} sectionID Section ID
 * @param {string} rowID Row ID  
 * @param {string} seatId Seat ID (not displayOrder!)
 * @returns {number|null} Dynamic price in cents or null if not found
 */
function getDynamicPrice(priceLevelData, sectionID, rowID, seatId) {
  if (!priceLevelData.rawDynamicPrices || !priceLevelData.priceTypeID) {
    return null;
  }

  // Build the dynamic price key: priceTypeID-sectionID-rowID-seatId-priceLevelID
  const dynamicPriceKey = `${priceLevelData.priceTypeID}-${sectionID}-${rowID}-${seatId}-${priceLevelData.priceLevelID}`;
  
  return priceLevelData.rawDynamicPrices[dynamicPriceKey] || null;
}

/**
 * Helper function to calculate pricing for a specific seat with dynamic pricing support
 * @param {Object} priceLevelData Base price level data
 * @param {string} sectionID Section ID
 * @param {string} rowID Row ID
 * @param {string} seatId Seat ID
 * @param {Object} rootFeeMap Map of fees
 * @param {Object} taxMap Map of taxes
 * @returns {Object} Calculated pricing for the specific seat
 */
function calculateSeatPricing(priceLevelData, sectionID, rowID, seatId, rootFeeMap, taxMap) {
  // Check if there's a dynamic price for this specific seat
  const dynamicPrice = getDynamicPrice(priceLevelData, sectionID, rowID, seatId);
  
  let baseAmountForCalculation;
  let baseComponentAmount;
  let venFacFeeAmount = priceLevelData.facilityFee;
  
  if (dynamicPrice !== null) {
    // Use dynamic price as the total base amount (this replaces both base component + facility fee)
    baseAmountForCalculation = dynamicPrice;
    baseComponentAmount = dynamicPrice - venFacFeeAmount; // Subtract facility fee to get base component
  } else {
    // Use regular pricing
    baseAmountForCalculation = priceLevelData.basePrice + priceLevelData.facilityFee;
    baseComponentAmount = priceLevelData.basePrice;
  }

  // For fees and taxes, use the pre-calculated values from priceLevelData
  // This maintains consistency with the original calculation method
  const totalCalculatedPerItemFees = priceLevelData.totalFees;
  const totalTax = priceLevelData.totalTax;
  
  // Calculate final price
  const websiteDisplayPrice = baseAmountForCalculation + totalCalculatedPerItemFees + totalTax;

  return {
    basePrice: baseComponentAmount,
    facilityFee: venFacFeeAmount,
    totalFees: totalCalculatedPerItemFees,
    totalTax: totalTax,
    websiteDisplayPrice: websiteDisplayPrice,
    isDynamicPricing: dynamicPrice !== null
  };
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

    // Map global fees and taxes for seat-specific calculations
    const rootFeeMap = {};
    if (axsResults.price && axsResults.price.fees && Array.isArray(axsResults.price.fees)) {
      for (const fee of axsResults.price.fees) {
        rootFeeMap[fee.id] = fee;
      }
    }

    const taxMap = {};
    if (axsResults.price && axsResults.price.taxes && Array.isArray(axsResults.price.taxes)) {
      for (const tax of axsResults.price.taxes) {
        taxMap[tax.id] = tax;
      }
    }

    // If we have detailed offer data, process that for specific seats
    if (axsResults.offerSearch && axsResults.offerSearch.offers) {

      // Group seats by section, row, and price level
      const sectionRowPriceSeats = {};

      // First pass: Collect all valid seats
      for (const offer of axsResults.offerSearch.offers) {
        // Filter out FlashSale/resale offers based on offerType
        if (offer.offerType === "FLASHSEATS") {
          continue;
        }

        if (!offer.items || !Array.isArray(offer.items) || offer.items.length === 0) {
          continue;
        }

        for (const item of offer.items) {
          // Skip if not available or if it's accessible/restricted view
          if (item.statusCodeLabel && item.statusCodeLabel.toLowerCase() === "accessible") {
            continue;
          }

          if (item.attributes?.some(attr =>
              attr.toLowerCase().includes('restricted') ||
              attr.toLowerCase().includes('accessible')
            )) {
            continue;
          }

          if (item.seatType && item.seatType.toLowerCase().includes('flashseats')) {
            continue;
          }

          const key = `${item.sectionID}-${item.rowLabel}`;

          if (!sectionRowPriceSeats[key]) {
            sectionRowPriceSeats[key] = {
              sectionLabel: item.sectionLabel,
              sectionID: item.sectionID,
              rowLabel: item.rowLabel,
              rowID: item.rowID,
              seats: []
            };
          }

          sectionRowPriceSeats[key].seats.push({
            number: parseInt(item.number),
            displayOrder: item.displayOrder,
            seatId: item.id, // Use seat ID for dynamic pricing lookup
            offerId: offer.offerID,
            priceLevelId: item.priceLevelID
          });
        }
      }

      // Second pass: Process each section-row group to find valid pairs or singles
      for (const key in sectionRowPriceSeats) {
        const groupData = sectionRowPriceSeats[key];

        // Group seats by price level within this section-row
        const seatsByPriceLevel = {};
        for (const seat of groupData.seats) {
          if (!seatsByPriceLevel[seat.priceLevelId]) {
            seatsByPriceLevel[seat.priceLevelId] = [];
          }
          seatsByPriceLevel[seat.priceLevelId].push(seat);
        }

        // Find the price level with the most seats (or lowest price if tied)
        let bestPriceLevelId = null;
        let maxSeats = 0;
        let lowestPrice = Infinity;

        for (const priceLevelId in seatsByPriceLevel) {
          const seats = seatsByPriceLevel[priceLevelId];
          const priceLevelData = priceLevelsMap[priceLevelId];
          
          if (!priceLevelData) {
            continue;
          }

          // Calculate average price for this price level (considering dynamic pricing)
          let totalPrice = 0;
          for (const seat of seats) {
            const seatPricing = calculateSeatPricing(
              priceLevelData, 
              groupData.sectionID, 
              groupData.rowID, 
              seat.seatId, 
              rootFeeMap, 
              taxMap
            );
            totalPrice += seatPricing.websiteDisplayPrice;
          }
          const averagePrice = totalPrice / seats.length / 100; // Convert to dollars
          
          // Prefer price level with more seats, or lower average price if same number of seats
          if (seats.length > maxSeats || (seats.length === maxSeats && averagePrice < lowestPrice)) {
            bestPriceLevelId = priceLevelId;
            maxSeats = seats.length;
            lowestPrice = averagePrice;
          }
        }

        if (!bestPriceLevelId) {
          console.warn(`No valid price level found for section-row: ${groupData.sectionLabel} ${groupData.rowLabel}`);
          continue;
        }

        const selectedSeats = seatsByPriceLevel[bestPriceLevelId];
        const priceLevelData = priceLevelsMap[bestPriceLevelId];

        // Sort seats by number to find consecutive groups
        selectedSeats.sort((a, b) => a.number - b.number);

        // Find the best consecutive group (largest group, 2-4 seats only)
        let bestGroup = [];
        let currentGroup = [];

        for (let i = 0; i < selectedSeats.length; i++) {
          const currentSeat = selectedSeats[i];
          
          if (currentGroup.length === 0) {
            // Start new group
            currentGroup = [currentSeat];
          } else {
            const lastSeat = currentGroup[currentGroup.length - 1];
            if (currentSeat.number === lastSeat.number + 1 && currentGroup.length < 4) {
              // Consecutive seat, add to current group (max 4 seats)
              currentGroup.push(currentSeat);
            } else {
              // Not consecutive or group is full, check if current group is better than best
              // Only consider groups with 2-4 seats
              if (currentGroup.length >= 2 && currentGroup.length > bestGroup.length) {
                bestGroup = [...currentGroup];
              }
              // Start new group with current seat
              currentGroup = [currentSeat];
            }
          }
        }

        // Check the last group - only consider groups with 2-4 seats
        if (currentGroup.length >= 2 && currentGroup.length > bestGroup.length) {
          bestGroup = [...currentGroup];
        }

        // Only create ticket entry if we have a valid group of 2-4 seats
        if (bestGroup.length >= 2) {
          // Calculate pricing for the first seat in the group (representative pricing)
          const firstSeat = bestGroup[0];
          
          const seatPricing = calculateSeatPricing(
            priceLevelData, 
            groupData.sectionID, 
            groupData.rowID, 
            firstSeat.seatId, 
            rootFeeMap, 
            taxMap
          );

          // Get the connection fee for the current section
          const sectionData = axsResults.sections[groupData.sectionLabel];
          let connectionFee = 0;
          if (sectionData && typeof sectionData.connectionFee === 'number') {
            connectionFee = sectionData.connectionFee;
          }

          // Calculate final prices with proper conversion and rounding
          const face_price = parseFloat(((seatPricing.basePrice + seatPricing.facilityFee) / 100).toFixed(2));
          const taxed_cost = parseFloat(((seatPricing.totalFees + seatPricing.totalTax) / 100).toFixed(2));
          const connection_fee_dollars = parseFloat((connectionFee / 100).toFixed(2));
          
          // Cost should be exactly face_price + taxed_cost + connection_fee
          const cost = parseFloat((face_price + taxed_cost + connection_fee_dollars).toFixed(2));

          tickets.push({
            section: groupData.sectionLabel,
            row: groupData.rowLabel,
            seats: bestGroup.map(s => s.number).join(','),
            quantity: bestGroup.length,
            face_price: face_price,
            taxed_cost: taxed_cost,
            cost: cost,
            isDynamicPricing: seatPricing.isDynamicPricing,
            connection_fee: connection_fee_dollars // Add this for debugging
          });
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