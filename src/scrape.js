import puppeteer from "puppeteer-core"
import fs from 'fs/promises'
// Import the parsing functions
import { parseAXSTickets } from './parse_tickets.js'
import { randomUUID } from "crypto"

// Custom error classes for better error handling
class ScraperBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScraperBlockedError';
    this.needsSessionClose = true;
  }
}

class CaptchaTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaptchaTimeoutError';
    this.needsSessionClose = true;
  }
}

class BrowserConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserConnectionError';
    this.needsSessionClose = false; // Browser never connected
  }
}

class DataCaptureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataCaptureError';
    this.needsSessionClose = true;
  }
}

const initBrowser = async () => {
  try {
    const query = new URLSearchParams({
      token: process.env.SCRAPELESS_TOKEN,
      proxy_country: "US",
      session_recording: false,
      session_ttl: 900,
      session_name: randomUUID(), // Generate unique session name for each request
    })

    const connectionURL = `wss://browser.scrapeless.com/browser?${query.toString()}`

    console.log("Connecting to browser...")
    
    // Add timeout handling for the browser connection
    const browserPromise = puppeteer.connect({
      browserWSEndpoint: connectionURL,
      defaultViewport: null,
    })
    
    // Add a timeout for browser connection (reduced from 30s to 15s)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new BrowserConnectionError('Browser connection timeout after 15 seconds'))
      }, 15000)
    })
    
    // Race the connection against the timeout
    const browser = await Promise.race([browserPromise, timeoutPromise])
    console.log("Browser connected successfully")
    
    return browser
  } catch (error) {
    console.error("Error initializing browser:", error)
    if (error instanceof BrowserConnectionError) {
      throw error;
    }
    throw new BrowserConnectionError(`Browser connection failed: ${error.message}`)
  }
}

// Main scraping function
async function scrapeAxsTickets(url) {
  let browser = null
  let page = null
  const startTime = Date.now();
  const MAX_SESSION_TIME = 5 * 60 * 1000; // 5 minutes
  const CAPTCHA_TIMEOUT = 60 * 1000; // 60 seconds
  
  // Helper function to check if we've exceeded max session time
  const checkSessionTimeout = () => {
    if (Date.now() - startTime > MAX_SESSION_TIME) {
      throw new DataCaptureError("Session timeout: Maximum 5 minutes exceeded");
    }
  };
  
  try {
    // Create new browser instance for this request
    browser = await initBrowser()
    
    // Create page first
    page = await browser.newPage()
    
    // Target XHR endpoints we want to capture
    const targetEndpoints = [
      { pattern: "/veritix/inventory/V2/*/sections", filename: "sections", found: false },
      { pattern: "/veritix/inventory/V2/*/offer/search", filename: "offer_search", found: false },
      { pattern: "/veritix/inventory/v4/*/price", filename: "price", found: false }
    ]
    
    // Store captured responses
    const capturedResponses = new Map()
    
    // DEBUG: Track all inventory-related requests and responses
    const inventoryRequests = []
    const inventoryResponses = new Map()
    
    // Handle response differently - capture response data properly
    const responseHandler = async (response) => {
      const url = response.url()
      const status = response.status()
      
      if (!url.includes('veritix/inventory') || status !== 200) {
        return
      }
      
      try {
        let responseText
        try {
          responseText = await response.text().catch(e => {
            console.log(`⚠️ Could not get response text for ${url}: ${e.message}`)
            return null
          })
        } catch (textError) {
          console.log(`⚠️ Error getting response text for ${url}: ${textError.message}`)
          return
        }
        
        if (!responseText) {
          return
        }
        
        console.log(`📥 INVENTORY RESPONSE: ${status} for ${url}`)
        
        inventoryResponses.set(url, responseText)
        
        for (const target of targetEndpoints) {
          const patternParts = target.pattern.split('*')
          const matches = patternParts.every(part => url.includes(part))
          
          if (matches) {
            try {
              const responseJson = JSON.parse(responseText)
              console.log(`✅ Captured response for: ${target.filename}`)
              capturedResponses.set(target.filename, responseJson)
              target.found = true
              
              const allCaptured = targetEndpoints.every(endpoint => endpoint.found)
              if (allCaptured) {
                console.log("🎯 All three target responses have been captured!")
                allResponsesResolve()
              }
            } catch (jsonError) {
              console.log(`⚠️ Response for ${target.filename} is not valid JSON:`, jsonError.message)
              capturedResponses.set(target.filename, responseText)
              target.found = true
            }
            break
          }
        }
      } catch (responseError) {
        console.error(`⚠️ Error processing response for ${url}:`, responseError.message)
      }
    }
    
    // Set up a more reliable way to capture responses
    page.on('response', async response => {
      // Process later to avoid blocking the response handling
      responseHandler(response).catch(err => {
        console.error("Error in response handler:", err)
      })
    })
    
    // Monitor all requests containing veritix/inventory
    page.on('request', request => {
      const url = request.url()
      if (url.includes('veritix/inventory')) {
        const timestamp = new Date().toISOString()
        const requestInfo = {
          timestamp,
          url,
          method: request.method(),
          resourceType: request.resourceType()
        }
        inventoryRequests.push(requestInfo)
        console.log(`🔍 [${timestamp}] INVENTORY REQUEST: ${request.method()} ${url}`)
      }
    })
    
    // Promise resolver for all responses captured
    let allResponsesResolve
    const allResponsesCapturedPromise = new Promise(resolve => {
      allResponsesResolve = resolve
    })
    
    // Alternative method to capture responses via CDP
    const setupCDPNetworkMonitoring = async () => {
      try {
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        
        client.on('Network.responseReceived', async (event) => {
          const { requestId, response } = event;
          const url = response.url;
          
          if (!url.includes('veritix/inventory') || response.status !== 200) {
            return;
          }
          
          try {
            // Get response body using CDP
            const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId });
            const responseText = base64Encoded ? atob(body) : body;
            
            console.log(`📥 CDP CAPTURED: ${response.status} for ${url}`);
            
            // Store the response
            inventoryResponses.set(url, responseText);
            
            // Check against target endpoints
            for (const target of targetEndpoints) {
              const patternParts = target.pattern.split('*');
              const matches = patternParts.every(part => url.includes(part));
              
              if (matches) {
                try {
                  const responseJson = JSON.parse(responseText);
                  console.log(`✅ CDP Captured response for: ${target.filename}`);
                  capturedResponses.set(target.filename, responseJson);
                  target.found = true;
                  
                  // Check if all responses are captured
                  const allCaptured = targetEndpoints.every(endpoint => endpoint.found);
                  if (allCaptured) {
                    console.log("🎯 All three target responses have been captured via CDP!");
                    allResponsesResolve();
                  }
                } catch (jsonError) {
                  console.log(`⚠️ CDP Response for ${target.filename} is not valid JSON:`, jsonError.message);
                  capturedResponses.set(target.filename, responseText);
                  target.found = true;
                }
                break;
              }
            }
          } catch (err) {
            console.log(`⚠️ CDP Error for ${url}:`, err.message);
          }
        });
      } catch (error) {
        console.error("Failed to set up CDP monitoring:", error.message);
        console.log("Continuing without CDP monitoring - will rely on standard response listener");
      }
    }
    
    // Set up CDP monitoring as a more reliable way to capture responses
    await setupCDPNetworkMonitoring()
    
    console.log("Navigating to URL:", url)
    checkSessionTimeout(); // Check before navigation
    
    try {
      await page.goto(url, { timeout: 30000, waitUntil: "load" })
    } catch (navigationError) {
      throw new DataCaptureError(`Failed to navigate to URL: ${navigationError.message}`)
    }
    
    // Main retry loop for captcha and data capture
    let captchaRetries = 0;
    const maxCaptchaRetries = 3;
    
    while (captchaRetries < maxCaptchaRetries) {
      checkSessionTimeout(); // Check before each retry
      
      console.log(`Captcha attempt ${captchaRetries + 1}/${maxCaptchaRetries}`);
      
      // Create a promise to wait for the specific pre-flow request to detect captcha solve
      const preFlowRequestPromise = new Promise(resolve => {
        const handler = (request) => {
          if (request.url().includes('/veritix/pre-flow/v2/')) {
            console.log('🎉 Pre-flow request detected: Captcha solved!')
            console.log('Request URL:', request.url())
            page.off('request', handler); // Remove listener
            resolve(request)
          }
        };
        page.on('request', handler);
      });
      
      // Listen for captcha events using native promise resolve
      const captchaPromise = addCaptchaListener(page)
      
      // Wait for captcha to be solved with 60s timeout
      console.log("Waiting for captcha to be solved...")
      
      try {
        await Promise.race([
          preFlowRequestPromise,
          onCaptchaFinished(captchaPromise, CAPTCHA_TIMEOUT),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Captcha timeout")), CAPTCHA_TIMEOUT)
          )
        ]);
        console.log("Captcha solved - continuing with data capture");
        break; // Exit retry loop if captcha is solved
      } catch (captchaError) {
        captchaRetries++;
        console.log(`Captcha attempt ${captchaRetries} failed:`, captchaError.message);
        
        if (captchaRetries >= maxCaptchaRetries) {
          throw new CaptchaTimeoutError(`Failed to solve captcha after ${maxCaptchaRetries} attempts`);
        }
        
        // Check for blocking modal before retrying
        try {
          const blockingModal = await page.$('.modal-header h1#title');
          if (blockingModal) {
            const modalText = await page.evaluate(el => el.textContent, blockingModal);
            if (modalText.includes('Oh no!')) {
              console.error("❌ Scraper has been blocked - detected blocking modal");
              throw new ScraperBlockedError("Scraper has been blocked by AXS");
            }
          }
        } catch (modalError) {
          console.log("Error checking for blocking modal:", modalError.message);
        }
        
        // Refresh page for next attempt
        console.log("Refreshing page for next captcha attempt...");
        try {
          await page.reload({ waitUntil: "load", timeout: 30000 });
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s after reload
        } catch (reloadError) {
          console.log("Error reloading page:", reloadError.message);
        }
      }
    }
    
    // Now try to capture data with remaining time
    checkSessionTimeout();
    
    const remainingTime = MAX_SESSION_TIME - (Date.now() - startTime);
    const dataTimeout = Math.max(remainingTime - 5000, 10000); // Leave 5s buffer, minimum 10s
    
    console.log(`Attempting data capture with ${Math.round(dataTimeout/1000)}s timeout...`);
    
    // Create a promise with timeout for capturing all responses
    const captureWithTimeout = (timeoutMs) => {
      return Promise.race([
        allResponsesCapturedPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new DataCaptureError("Timeout waiting for all responses")), timeoutMs)
        )
      ])
    }
    
    try {
      // Try to capture responses immediately with short timeout first
      await captureWithTimeout(10000).catch(async () => {
        console.log("Initial capture failed, trying refresh approach...");
        checkSessionTimeout();
        
        // Wait for header to load
        await page.waitForSelector(".header", { timeout: 5000 }).catch(err => {
          console.log("Header wait error (continuing anyway):", err.message)
        })

        // Check for blocking modal one more time
        const blockingModal = await page.$('.modal-header h1#title');
        if (blockingModal) {
          const modalText = await page.evaluate(el => el.textContent, blockingModal);
          if (modalText.includes('Oh no!')) {
            console.error("❌ Scraper has been blocked - detected blocking modal");
            throw new ScraperBlockedError("Scraper has been blocked by AXS");
          }
        }
        
        // Try to find and click refresh button
        let buttonClicked = false
        
        try {
          await page.waitForSelector(".sc-hzyFKJ", { timeout: 3000 })
          await page.click(".sc-hzyFKJ")
          console.log("Refresh button clicked")
          buttonClicked = true
        } catch (selectorError) {
          console.log("Primary refresh button not found, trying alternative...")
        }
        
        if (!buttonClicked) {
          // Try to find by text content
          const refreshButtons = await page.$$('button')
          
          for (const button of refreshButtons) {
            const textContent = await page.evaluate(el => el.textContent, button)
            if (textContent && textContent.toLowerCase().includes('refresh')) {
              await button.click()
              console.log("Found and clicked refresh button by text")
              buttonClicked = true
              break
            }
          }
        }
        
        if (!buttonClicked) {
          console.log("No refresh button found, reloading page...")
          await page.reload({ waitUntil: "networkidle2" })
        }
        
        // Wait for responses after refresh with remaining session time
        const finalRemainingTime = MAX_SESSION_TIME - (Date.now() - startTime);
        const finalTimeout = Math.max(finalRemainingTime - 5000, 10000); // Leave 5s buffer, minimum 10s
        console.log(`Waiting for responses with ${Math.round(finalTimeout/1000)}s timeout (remaining session time)...`);
        return captureWithTimeout(finalTimeout)
      })
      
      console.log("✅ Successfully captured all required responses!")
    } catch (timeoutError) {
      if (timeoutError instanceof DataCaptureError || timeoutError instanceof ScraperBlockedError) {
        throw timeoutError;
      }
      throw new DataCaptureError("Failed to capture required data within timeout");
    }
    
    // Check which responses we captured
    let allCaptured = true
    for (const target of targetEndpoints) {
      if (!capturedResponses.has(target.filename)) {
        console.log(`⚠️ Warning: Did not capture response for ${target.filename}`)
        allCaptured = false
      }
    }
    
    if (!allCaptured) {
      throw new DataCaptureError("Failed to capture all required responses");
    }
    
    // Create return object with the three responses
    const result = {
      sections: capturedResponses.get("sections") || null,
      offerSearch: capturedResponses.get("offer_search") || null,
      price: capturedResponses.get("price") || null,
      url: url
    }
    
    // Debug: Log what we have in capturedResponses
    console.log("🔍 Debug - capturedResponses keys:", Array.from(capturedResponses.keys()))
    console.log("🔍 Debug - result object:", {
      sections: result.sections ? "✅ Present" : "❌ Missing",
      offerSearch: result.offerSearch ? "✅ Present" : "❌ Missing", 
      price: result.price ? "✅ Present" : "❌ Missing"
    })
    
    // Save the three responses to separate JSON files for debugging
    console.log("🔍 Starting to save debug files...")
    console.log("🔍 Current working directory:", process.cwd())
    try {
      if (result.sections) {
        console.log("🔍 Attempting to save sections.json...")
        await fs.writeFile('./sections.json', JSON.stringify(result.sections, null, 2))
        console.log("✅ Saved sections.json")
      } else {
        console.log("❌ No sections data to save")
      }
      
      if (result.offerSearch) {
        console.log("🔍 Attempting to save offer_search.json...")
        await fs.writeFile('./offer_search.json', JSON.stringify(result.offerSearch, null, 2))
        console.log("✅ Saved offer_search.json")
      } else {
        console.log("❌ No offer_search data to save")
      }
      
      if (result.price) {
        console.log("🔍 Attempting to save price.json...")
        await fs.writeFile('./price.json', JSON.stringify(result.price, null, 2))
        console.log("✅ Saved price.json")
      } else {
        console.log("❌ No price data to save")
      }
    } catch (saveError) {
      console.error("❌ Error saving debug files:", saveError.message)
      console.error("❌ Full error:", saveError)
    }
    
    // If we successfully scraped the data, parse the tickets
    if (result.sections && result.offerSearch && result.price) {
      console.log("Parsing ticket data...")
      try {
        // Parse the tickets directly using the captured data
        const tickets = await parseAXSTickets({
          sections: result.sections,
          offerSearch: result.offerSearch,
          price: result.price,
          url: url
        })

        fs.writeFile('tickets.json', JSON.stringify(tickets, null, 2))
        
        console.log(`✅ Successfully scraped ${tickets.length} ticket groups in ${Math.round((Date.now() - startTime)/1000)}s`);
        
        // Return just the tickets array
        return tickets
        
      } catch (parseError) {
        console.error("Error parsing ticket data:", parseError)
        throw new DataCaptureError(`Failed to parse ticket data: ${parseError.message}`)
      }
    } else {
      throw new DataCaptureError("Failed to capture all required data")
    }
    
  } catch (error) {
    console.error("Main error:", error)
    
    // Determine if we need to close the session based on error type
    const needsSessionClose = error.needsSessionClose !== undefined ? error.needsSessionClose : true;
    
    if (needsSessionClose && browser) {
      console.log("Error requires session closure, closing browser...");
      try {
        await browser.close();
        browser = null;
      } catch (closeError) {
        console.error("Error closing browser:", closeError);
      }
    }
    
    throw error;
  } finally {
    // Clean up resources
    if (page) {
      try {
        await page.close()
        console.log("Page closed successfully")
      } catch (pageCloseError) {
        console.error("Error closing page:", pageCloseError)
      }
    }
    if (browser) {
      try {
        await browser.close()
        console.log("Browser closed successfully")
      } catch (browserCloseError) {
        console.error("Error closing browser:", browserCloseError)
      }
    }
  }
}

async function addCaptchaListener(page) {
  return new Promise(async (resolve) => {
    try {
      // Use page.target().createCDPSession() instead of page.createCDPSession()
      const client = await page.target().createCDPSession();

      client.on("Captcha.detected", (msg) => {
        console.log("Captcha.detected:", msg);
      });

      client.on("Captcha.solveFinished", async (msg) => {
        console.log("Captcha.solveFinished:", msg);
        resolve(msg);
        client.removeAllListeners();
      });
    } catch (error) {
      console.error("Error setting up captcha listener:", error.message);
      // Resolve with a fallback value since we don't want this to fail the entire process
      resolve({ error: "Captcha listener setup failed" });
    }
  });
}

async function onCaptchaFinished(promise, timeout = 60000) {
  try {
    return await Promise.race([
      promise, 
      new Promise((_, reject) => setTimeout(() => reject(new Error("Captcha listener timeout")), timeout))
    ]);
  } catch (error) {
    console.log(`Captcha handler error: ${error.message}`);
    throw error;
  }
}

// Export the main scraping function
export { scrapeAxsTickets };

// Example usage
async function runExample() {
  try {
    const testUrl = process.argv[2] || "https://tix.axs.com/gHEUIQAAAAAbXCaaAgAAAAAN%2fv%2f%2f%2fwD%2f%2f%2f%2f%2fA2dnYQD%2f%2f%2f%2f%2f%2f%2f%2f%2f%2fw%3d%3d?skin=&tags=&cpch=&cpdate=&cprid=&cpid=&cpcn=&cpdid=&cpdn=&cpsrc=&intoff=&cid=&utm_source=&utm_medium=&utm_campaign=&utm_term=&utm_content=&aff=&clickref=&promocode=&originalReferringURL=&upgrade=&mkt_campaign=&q=00000000-0000-0000-0000-000000000000&p=d84967d9-9e90-4386-892d-1f9bcb989428&ts=1746807083&c=axs&e=55498790443656796&rt=AfterEvent&h=7e1142f7d0823c4f7da70ff1af393bba"
    
    console.log("Starting scrape process...")
    const results = await scrapeAxsTickets(testUrl)
    console.log("Results obtained:", {
      sections: results.sections ? "✅ Captured" : "❌ Missing",
      offerSearch: results.offerSearch ? "✅ Captured" : "❌ Missing",
      price: results.price ? "✅ Captured" : "❌ Missing",
      parsedTickets: results.parsedTickets ? `✅ ${results.parsedTickets.count} tickets saved` : "❌ Not parsed"
    })
  } catch (error) {
    console.error("Error in example:", error)
  }
}

// Run the example if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runExample()
}