import puppeteer from "puppeteer-core"
import fs from 'fs/promises'
// Import the parsing functions
import { parseAXSTickets } from './parse_tickets.js'
import { randomUUID } from "crypto"

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
    
    // Add a timeout for browser connection
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Browser connection timeout after 30 seconds'))
      }, 30000)
    })
    
    // Race the connection against the timeout
    const browser = await Promise.race([browserPromise, timeoutPromise])
    console.log("Browser connected successfully")
    
    return browser
  } catch (error) {
    console.error("Error initializing browser:", error)
    throw new Error(`Browser connection failed: ${error.message}`)
  }
}

// Main scraping function
async function scrapeAxsTickets(url) {
  let browser = null
  let page = null
  
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
    
    // Create a promise to wait for the specific pre-flow request to detect captcha solve
    const preFlowRequestPromise = new Promise(resolve => {
      page.on('request', request => {
        if (request.url().includes('/veritix/pre-flow/v2/')) {
          console.log('🎉 Pre-flow request detected: Captcha solved!')
          console.log('Request URL:', request.url())
          resolve(request)
        }
      })
    })
    
    // Listen for captcha events using native promise resolve (keeping as fallback)
    const captchaPromise = addCaptchaListener(page)
    
    // Create a promise with timeout for capturing all responses
    const captureWithTimeout = (timeoutMs = 180000) => {
      return Promise.race([
        allResponsesCapturedPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Timeout waiting for all responses")), timeoutMs)
        )
      ])
    }
    
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
    await page.goto(url, { timeout: 30000, waitUntil: "load" })
    
    // Wait for either the pre-flow request or the captcha solve event
    console.log("Waiting for captcha to be solved (monitoring pre-flow request)...")
    
    try {
      await Promise.race([
        preFlowRequestPromise,
        onCaptchaFinished(captchaPromise)
      ]);
      console.log("Captcha solved or pre-flow detected - continuing with browsing operations");
    } catch (captchaError) {
      console.log("Captcha handling error:", captchaError.message || captchaError);
      console.log("Continuing anyway - will try to proceed with page operations");
    }
    
    try {
      // First try: Check if all three responses are captured immediately after captcha
      console.log("Checking if responses are available after initial captcha solve...")
      await captureWithTimeout(15000).catch(async () => {
        console.log("Not all responses available yet. Proceeding with refresh...")
        
        console.log("Page loaded...")
        
        // Wait a moment for the page to fully render post-captcha
        console.log("Waiting for header to load...")
        await page.waitForSelector(".header", { timeout: 10000 }).catch(err => {
          console.log("Header wait error (continuing anyway):", err.message)
        })

        // Check for blocking modal
        const blockingModal = await page.$('.modal-header h1#title');
        if (blockingModal) {
          const modalText = await page.evaluate(el => el.textContent, blockingModal);
          if (modalText.includes('Oh no!')) {
            console.error("❌ Scraper has been blocked - detected blocking modal");
            throw new Error("Scraper has been blocked by AXS");
          }
        }
        
        console.log("Looking for and trying to click the Refresh button...")
        
        // Try different selectors to find the Refresh button
        let buttonClicked = false
        
        try {
          await page.waitForSelector(".sc-hzyFKJ", { timeout: 5000 })
          await page.click(".sc-hzyFKJ")
          console.log("Button clicked using first selector")
          buttonClicked = true
        } catch (selectorError) {
          console.log("First selector failed, trying alternative approach...")
        }
        
        if (!buttonClicked) {
          // Try to find by text content
          const refreshButtons = await page.$$('button')
          
          for (const button of refreshButtons) {
            const textContent = await page.evaluate(el => el.textContent, button)
            if (textContent && textContent.toLowerCase().includes('refresh')) {
              await button.click()
              console.log("Found and clicked button with 'refresh' text")
              buttonClicked = true
              break
            }
          }
        }
        
        if (!buttonClicked) {
          console.log("Could not find refresh button - trying to reload the page")
          await page.reload({ waitUntil: "networkidle2" })
        }
        
        // Now wait for responses after refresh (with longer timeout)
        console.log("Waiting for target responses after page refresh...")
        return captureWithTimeout(120000)
      })
      
      console.log("✅ Successfully captured all required responses!")
    } catch (timeoutError) {
      console.log("⚠️ Timed out waiting for all responses. Saving what we have...")
      
      // Log what requests were seen but responses not captured
      console.log("DEBUG: Checking for missing responses...")
      
      // Check which inventory requests didn't have matching responses captured
      for (const req of inventoryRequests) {
        for (const target of targetEndpoints) {
          const patternParts = target.pattern.split('*')
          const matches = patternParts.every(part => req.url.includes(part))
          
          if (matches && !capturedResponses.has(target.filename)) {
            console.log(`⚠️ Found request for ${target.filename} but response was not captured: ${req.url}`)
            
            // Check if we actually have this response in our inventory responses Map
            if (inventoryResponses.has(req.url)) {
              console.log(`🔄 Found response in inventory responses, attempting recovery...`)
              const responseText = inventoryResponses.get(req.url)
              
              try {
                const responseJson = JSON.parse(responseText)
                console.log(`🔄 Recovered response for: ${target.filename}`)
                capturedResponses.set(target.filename, responseJson)
              } catch (jsonError) {
                console.log(`⚠️ Recovered response for ${target.filename} is not valid JSON`)
                capturedResponses.set(target.filename, responseText)
              }
            }
          }
        }
      }
    }
    
    // Save all captured responses before exiting
    for (const [filename, responseData] of capturedResponses.entries()) {
      try {
        await fs.writeFile(filename + '.json', JSON.stringify(responseData, null, 2))
        console.log(`Saved captured response to ${filename}.json`)
      } catch (writeError) {
        console.error(`Error saving response to ${filename}:`, writeError)
      }
    }
    
    // Save inventory responses to a debug file
    try {
      const inventoryResponseData = {}
      for (const [url, responseText] of inventoryResponses.entries()) {
        try {
          inventoryResponseData[url] = JSON.parse(responseText)
        } catch (e) {
          // If not valid JSON, save a truncated version of the raw text
          inventoryResponseData[url] = { 
            raw: responseText.substring(0, 500) + "... [truncated]",
            parseError: e.message
          }
        }
      }
      
      await fs.writeFile('inventory_responses_debug.json', JSON.stringify(inventoryResponseData, null, 2))
      console.log("Saved inventory responses to inventory_responses_debug.json")
    } catch (debugWriteError) {
      console.error("Error saving response debug info:", debugWriteError)
    }
    
    // Check which responses we captured in the end
    let allCaptured = true
    for (const target of targetEndpoints) {
      if (!capturedResponses.has(target.filename)) {
        console.log(`⚠️ Warning: Did not capture response for ${target.filename}`)
        allCaptured = false
      }
    }
    
    if (allCaptured) {
      console.log("✅ Successfully captured and saved all required responses!")
    } else {
      console.log("⚠️ Some responses could not be captured.")
    }
    
    // Create return object with the three responses
    const result = {
      sections: capturedResponses.get("sections") || null,
      offerSearch: capturedResponses.get("offer_search") || null,
      price: capturedResponses.get("price") || null,
      url: url
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
        
        // Return just the tickets array
        return tickets
        
      } catch (parseError) {
        console.error("Error parsing ticket data:", parseError)
        throw parseError
      }
    } else {
      throw new Error("Failed to capture all required data")
    }
    
  } catch (error) {
    console.error("Main error:", error)
    throw error 
  } finally {
    // Safely close the page and browser
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

async function onCaptchaFinished(promise, timeout = 360_000) {
  try {
    return await Promise.race([
      promise, 
      new Promise((_, reject) => setTimeout(() => reject(new Error("Captcha timeout")), timeout))
    ]);
  } catch (error) {
    console.log(`Captcha handler error: ${error.message}`);
    // Return a fallback value that indicates timeout but doesn't crash the flow
    return { error: error.message, timedOut: true };
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