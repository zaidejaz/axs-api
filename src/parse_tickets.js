import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
      
      // Process each offer in the offer search data
      for (const offer of axsResults.offerSearch.offers) {
        // Skip offers without items
        if (!offer.items || !Array.isArray(offer.items) || offer.items.length === 0) {
          continue;
        }
        
        // Group seats by section and row AND price level (to ensure same price)
        const sectionRowPriceSeats = {};
        
        // Process each seat (item) in the offer
        for (const item of offer.items) {
          // Key includes price level to ensure pairs have same price
          const sectionKey = `${item.sectionLabel}|${item.rowLabel}|${item.priceLevelID}`;
          
          // Initialize this section/row/price if it doesn't exist yet
          if (!sectionRowPriceSeats[sectionKey]) {
            sectionRowPriceSeats[sectionKey] = {
              section: item.sectionLabel,
              row: item.rowLabel,
              seats: [],
              priceLevelID: item.priceLevelID
            };
          }
          
          // Add this seat to the section/row/price
          sectionRowPriceSeats[sectionKey].seats.push(item.number);
        }
        
        // Now create tickets from the grouped seats, creating pairs of 2-4 seats
        for (const [key, groupData] of Object.entries(sectionRowPriceSeats)) {
          // Sort seats numerically for better pairing
          groupData.seats.sort((a, b) => {
            // Sort numerically if possible, otherwise alphabetically
            const numA = parseInt(a, 10);
            const numB = parseInt(b, 10);
            return (isNaN(numA) || isNaN(numB)) ? a.localeCompare(b) : numA - numB;
          });
          
          // Get price level info
          const priceLevelDetails = priceLevelsMap[groupData.priceLevelID] || null;
          if (!priceLevelDetails) {
            console.warn(`Warning: No price details found for price level ${groupData.priceLevelID} in ${groupData.section} row ${groupData.row}`);
            continue;
          }
          
          // Calculate pricing
          const facePrice = priceLevelDetails.base;
          const facilityFee = priceLevelDetails.facilityFee || 0;
          const taxRate = priceLevelDetails.taxRate || 0;
          const serviceFeeRate = priceLevelDetails.serviceFeeRate || 0;
          const convenienceFeeRate = priceLevelDetails.convenienceFeeRate || 0;
          const orderProcessingFee = priceLevelDetails.orderProcessingFee || 0;
          
          // Calculate fees
          const serviceFee = (facePrice * serviceFeeRate) / 100;
          const convenienceFee = (facePrice * convenienceFeeRate) / 100;
          const totalFeeBeforeTax = facilityFee + serviceFee + convenienceFee + orderProcessingFee;
          
          // Calculate tax amount (tax is applied to base price + fees)
          const taxAmount = ((facePrice + totalFeeBeforeTax) * taxRate) / 100;
          
          // Calculate total cost
          const totalCost = facePrice + totalFeeBeforeTax + taxAmount;
          
          // Find contiguous seat groups (2-4 seats)
          const seatGroups = findContiguousSeatGroups(groupData.seats, 2, 4);
          
          // Create tickets for each valid seat group
          for (const seatGroup of seatGroups) {
            // Create a ticket for this group
            tickets.push({
              section: groupData.section,
              row: groupData.row,
              seats: seatGroup.join(','),
              quantity: seatGroup.length,
              face_price: parseFloat(facePrice.toFixed(2)),
              taxed_cost: parseFloat(taxAmount.toFixed(2)),
              cost: parseFloat(totalCost.toFixed(2))
            });
          }
        }
      }
    }

    // Return just the tickets array
    return tickets;
    
  } catch (error) {
    console.error("Error parsing AXS ticket data:", error);
    throw error;
  }
}

/**
 * Find contiguous seat groups that match specific size criteria
 * @param {Array} seats Array of seat numbers
 * @param {number} minSize Minimum size of a seat group (2 for pairs)
 * @param {number} maxSize Maximum size of a seat group (4 for quads)
 * @returns {Array} Array of seat groups that match the criteria
 */
function findContiguousSeatGroups(seats, minSize = 2, maxSize = 4) {
  const groups = [];
  const numericSeats = [];
  
  // Convert all seats to numbers if possible, otherwise use string comparison
  for (const seat of seats) {
    const seatNum = parseInt(seat, 10);
    numericSeats.push(isNaN(seatNum) ? seat : seatNum);
  }
  
  // Find contiguous groups
  let currentGroup = [seats[0]];
  let currentVal = numericSeats[0];
  
  for (let i = 1; i < seats.length; i++) {
    const nextVal = numericSeats[i];
    
    // Check if seats are contiguous by comparing numeric values
    if (typeof currentVal === 'number' && typeof nextVal === 'number' && nextVal === currentVal + 1) {
      currentGroup.push(seats[i]);
      currentVal = nextVal;
    } 
    // If using string comparison (for non-numeric seats), check if they are alphabetically adjacent
    else if (typeof currentVal === 'string' && typeof nextVal === 'string' && 
             nextVal.charCodeAt(0) === currentVal.charCodeAt(0) + 1) {
      currentGroup.push(seats[i]);
      currentVal = nextVal;
    } 
    // Start a new group if not contiguous
    else {
      // Save the current group if it meets size criteria
      if (currentGroup.length >= minSize && currentGroup.length <= maxSize) {
        groups.push([...currentGroup]);
      }
      currentGroup = [seats[i]];
      currentVal = nextVal;
    }
  }
  
  // Don't forget to check the last group
  if (currentGroup.length >= minSize && currentGroup.length <= maxSize) {
    groups.push(currentGroup);
  }
  
  return groups;
}

/**
 * Build a mapping of price levels to their details from the AXS results
 * @param {Object} axsResults The AXS results data
 * @returns {Object} Map of price level IDs to their details
 */
function buildPriceLevelsMap(axsResults) {
  const priceLevelsMap = {};
  
  // Extract tax rates
  const taxes = {};
  if (axsResults.price && axsResults.price.taxes) {
    for (const tax of axsResults.price.taxes) {
      taxes[tax.id] = tax.rate;
      console.log(`Found tax: ${tax.name} with rate ${tax.rate}%`);
    }
  }
  
  // Debug: Log all fees for examination
  if (axsResults.price && axsResults.price.fees) {
    console.log("All available fees in axs_results:");
    for (const fee of axsResults.price.fees) {
      console.log(`Fee ID: ${fee.id}, Name: ${fee.name}, Method: ${fee.calculationMethod}, Rate/Amount: ${fee.rate || fee.amount || 'N/A'}`);
    }
  }
  
  // Extract fees that apply at the offer level
  let serviceFeeRate = 0;
  let orderProcessingFee = 0;
  let convenienceFeeRate = 0;
  
  // Try to find service and processing fees in the offerPrices.fees section
  if (axsResults.price && axsResults.price.offerPrices) {
    // Check for any global fees referenced by the offers
    const feeIds = new Set();
    
    for (const offer of axsResults.price.offerPrices) {
      if (offer.fees) {
        for (const fee of offer.fees) {
          feeIds.add(fee.id);
        }
      }
    }
    
    console.log(`Offer references fee IDs: ${Array.from(feeIds).join(', ')}`);
    
    // Now look for these fees in the global fees section
    if (axsResults.price.fees) {
      for (const fee of axsResults.price.fees) {
        if (feeIds.has(fee.id)) {
          if (fee.name.includes('Service') || fee.name.includes('SVC')) {
            // This is likely a percentage-based service fee
            if (fee.calculationMethod === 'Percentage') {
              serviceFeeRate = fee.rate || 0;
              console.log(`Found service fee rate: ${serviceFeeRate}%`);
            }
          } else if (fee.name.includes('Process') || fee.name.includes('Order')) {
            // This is likely a fixed order processing fee
            if (fee.amount) {
              orderProcessingFee = fee.amount / 100; // Convert cents to dollars
              console.log(`Found order processing fee: $${orderProcessingFee}`);
            }
          } else if (fee.name.includes('Convenience') || fee.name.includes('CONV')) {
            // This is likely a percentage-based convenience fee
            if (fee.calculationMethod === 'Percentage') {
              convenienceFeeRate = fee.rate || 0;
              console.log(`Found convenience fee rate: ${convenienceFeeRate}%`);
            }
          }
        }
      }
    }
  }
  
  // If we couldn't find fees referenced by offers, set some default values based on common practice
  if (serviceFeeRate === 0 && convenienceFeeRate === 0) {
    console.log("No fee rates found in offer data, using default AXS fee structure");
    // AXS typically has a service fee of about 15-20% of the ticket price
    serviceFeeRate = 16.5;
    // Convenience fee is typically around 3-5%
    convenienceFeeRate = 3.5;
  }
  
  console.log(`Using fee rates: Service ${serviceFeeRate}%, Convenience ${convenienceFeeRate}%, Order Processing $${orderProcessingFee}`);
  
  // Process price data to get face values for each price level
  if (axsResults.price && axsResults.price.offerPrices) {
    for (const offer of axsResults.price.offerPrices) {
      for (const zonePrice of offer.zonePrices) {
        for (const priceLevel of zonePrice.priceLevels) {
          for (const price of priceLevel.prices) {
            // Initialize price level data
            const priceLevelData = {
              label: priceLevel.label,
              base: price.base / 100, // Convert cents to dollars
              priceTypeID: price.priceTypeID,
              facilityFee: 0,
              serviceFeeRate: serviceFeeRate,
              convenienceFeeRate: convenienceFeeRate,
              orderProcessingFee: orderProcessingFee,
              taxRate: 0,
              totalFees: 0,
              websiteDisplayPrice: 0
            };
            
            // Process price components to extract facility fees and taxes
            if (price.priceComponents) {
              for (const component of price.priceComponents) {
                if (!component.base && component.name.includes('Fee')) {
                  // This is a facility fee
                  priceLevelData.facilityFee += component.amount / 100; // Convert cents to dollars
                }
                
                // Get tax rate for this component
                if (component.taxIds && component.taxIds.length > 0) {
                  for (const taxId of component.taxIds) {
                    if (taxes[taxId]) {
                      priceLevelData.taxRate = Math.max(priceLevelData.taxRate, taxes[taxId]);
                    }
                  }
                }
              }
            }
            
            // Calculate total fees and website display price
            const basePrice = priceLevelData.base;
            const facilityFee = priceLevelData.facilityFee;
            
            // Calculate service fee (percentage of base price)
            const serviceFee = (basePrice * serviceFeeRate) / 100;
            
            // Calculate convenience fee (percentage of base price)
            const convenienceFee = (basePrice * convenienceFeeRate) / 100;
            
            // Sum all fees
            const totalFeeBeforeTax = facilityFee + serviceFee + convenienceFee + orderProcessingFee;
            priceLevelData.totalFees = totalFeeBeforeTax;
            
            // Apply tax to everything
            const totalTax = ((basePrice + totalFeeBeforeTax) * priceLevelData.taxRate) / 100;
            
            // Calculate website display price (base + all fees + tax)
            priceLevelData.websiteDisplayPrice = basePrice + totalFeeBeforeTax + totalTax;
            
            // Log the detailed price breakdown for debugging
            console.log(`Price level ${priceLevel.label} (${priceLevel.priceLevelID}): Base $${basePrice.toFixed(2)} + Fees $${totalFeeBeforeTax.toFixed(2)} + Tax $${totalTax.toFixed(2)} = Total $${priceLevelData.websiteDisplayPrice.toFixed(2)}`);
            
            // Store the price level data
            priceLevelsMap[priceLevel.priceLevelID] = priceLevelData;
          }
        }
      }
    }
  }
  
  return priceLevelsMap;
}

// Export only the parseAXSTickets function
export { parseAXSTickets }; 