import type { ServerConfig } from './types.js';
import { logger } from './logger.js';
import { chromium, type Browser, type Page } from 'playwright';

export interface SapNoteResult {
  id: string;
  title: string;
  summary: string;
  language: string;
  releaseDate: string;
  component?: string;
  url: string;
}

export interface SapNoteSearchResponse {
  results: SapNoteResult[];
  totalResults: number;
  query: string;
}

export interface SapNoteDetail {
  id: string;
  title: string;
  summary: string;
  content: string;
  language: string;
  releaseDate: string;
  component?: string;
  priority?: string;
  category?: string;
  url: string;
}

/**
 * SAP Notes API Client - Uses Coveo Search API
 * SAP uses Coveo as their search infrastructure for SAP Notes
 */
export class SapNotesApiClient {
  private config: ServerConfig;
  private baseUrl = 'https://launchpad.support.sap.com';
  private rawNotesUrl = 'https://me.sap.com/backend/raw/sapnotes';
  private coveoSearchUrl = 'https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2';
  private coveoOrgId = 'sapamericaproductiontyfzmfz0';
  
  // Persistent browser session to avoid session cookie expiration
  private browser: Browser | null = null;
  private browserContext: any = null;
  private browserLastUsed: number = 0;
  private readonly BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // Close browser after 5 minutes idle

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /**
   * Search for SAP Notes using the Coveo Search API
   */
  async searchNotes(query: string, token: string, maxResults: number = 10): Promise<SapNoteSearchResponse> {
    logger.info(`🔍 Searching SAP Notes for: "${query}"`);
    logger.debug(`📊 Search parameters: query="${query}", maxResults=${maxResults}`);

    try {
      // Try primary Coveo search approach
      try {
        logger.debug('🔍 Attempting primary Coveo search...');
        
        // Get Coveo bearer token from SAP authentication
        let coveoToken: string;
        try {
          coveoToken = await this.getCoveoToken(token);
          logger.debug(`✅ Successfully obtained Coveo token (length: ${coveoToken.length})`);
        } catch (tokenError) {
          const tokenErrorMsg = tokenError instanceof Error ? tokenError.message : String(tokenError);
          logger.warn(`⚠️ Coveo token extraction failed: ${tokenErrorMsg}`);
          throw new Error(`Coveo token extraction failed: ${tokenErrorMsg}`);
        }
        
        // Build Coveo search request
        const searchUrl = `${this.coveoSearchUrl}?organizationId=${this.coveoOrgId}`;
        logger.debug(`🌐 Coveo Search URL: ${searchUrl}`);

        const searchBody = this.buildCoveoSearchBody(query, maxResults);
        logger.debug(`📤 Coveo Search Body: ${JSON.stringify(searchBody, null, 2).substring(0, 500)}...`);

        const response = await fetch(searchUrl, {
          method: 'POST',
          headers: {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'authorization': `Bearer ${coveoToken}`,
            'content-type': 'application/json',
            'cookie': token,
            'referer': 'https://me.sap.com/',
            'origin': 'https://me.sap.com'
          },
          body: JSON.stringify(searchBody)
        });

        logger.debug(`📊 Coveo Response: ${response.status} ${response.statusText}`);

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(`❌ Coveo API error: ${errorText.substring(0, 200)}`);
          throw new Error(`Coveo API returned ${response.status}: ${errorText.substring(0, 100)}`);
        }

        const data = await response.json();
        logger.debug(`📄 Coveo Results: ${data.totalCount || 0} results found`);

        // Parse Coveo response to our format
        const results = this.parseCoveoResponse(data);
        
        logger.info(`✅ Found ${results.length} SAP Note(s) via Coveo`);
        logger.debug(`📄 Search results: ${JSON.stringify(results.map(r => ({ id: r.id, title: r.title })), null, 2)}`);

        return {
          results,
          totalResults: data.totalCount || results.length,
          query
        };
        
      } catch (coveoError) {
        const errorMessage = coveoError instanceof Error ? coveoError.message : String(coveoError);
        logger.warn(`⚠️ Primary Coveo search failed: ${errorMessage}`);
        logger.info('🔄 Attempting fallback search methods...');
        
        // Fallback 1: Direct note ID search (if query looks like a note ID)
        if (/^\d{6,8}$/.test(query.trim())) {
          logger.info(`🎯 Fallback 1: Query "${query}" appears to be a note ID, trying direct note access...`);
          try {
            const noteId = query.trim();
            const note = await this.getNote(noteId, token);
            if (note) {
              logger.info(`✅ Fallback 1 SUCCESS: Found SAP Note ${noteId} via direct access`);
              return {
                results: [{
                  id: noteId,
                  title: note.title,
                  summary: note.summary,
                  component: note.component,
                  releaseDate: note.releaseDate,
                  language: note.language,
                  url: note.url
                }],
                totalResults: 1,
                query
              };
            } else {
              logger.warn(`⚠️ Fallback 1: Direct note access returned null for note ${noteId}`);
            }
          } catch (directError) {
            logger.warn(`❌ Fallback 1 failed: ${directError instanceof Error ? directError.message : String(directError)}`);
          }
        } else {
          logger.debug(`📝 Query "${query}" doesn't match note ID pattern, skipping direct note access`);
        }
        
        // Fallback 2: SAP Internal Search API (bypasses Coveo)
        try {
          logger.info('🔄 Fallback 2: Trying SAP internal search API...');
          const fallbackResults = await this.searchViaInternalAPI(query, token, maxResults);
          if (fallbackResults && fallbackResults.length > 0) {
            logger.info(`✅ Fallback 2 SUCCESS: Found ${fallbackResults.length} result(s) via internal API`);
            return {
              results: fallbackResults,
              totalResults: fallbackResults.length,
              query
            };
          } else {
            logger.warn(`⚠️ Fallback 2: Internal API returned no results`);
          }
        } catch (internalError) {
          logger.warn(`❌ Fallback 2 failed: ${internalError instanceof Error ? internalError.message : String(internalError)}`);
        }
        
        // Fallback 3: Return helpful error message with guidance
        const helpfulMessage = `Search temporarily unavailable: Coveo search engine failed (${errorMessage}) and fallback search methods found no results.\n\n🔧 WORKAROUNDS:\n1. If you have a specific SAP Note ID (e.g., 2744792), use sap_note_get(id="2744792") - this works perfectly!\n2. Try searching directly on https://me.sap.com/notes\n3. Search may work better outside containerized environments\n\nNote: Individual note retrieval (sap_note_get) is fully functional and can access complete SAP Note content.`;
        
        logger.error(`❌ All search methods exhausted: ${helpfulMessage}`);
        throw new Error(helpfulMessage);
      }

    } catch (error) {
      logger.error('❌ SAP Notes search failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`SAP Notes search failed: ${errorMessage}`);
    }
  }

  /**
   * Get a specific SAP Note by ID
   */
  async getNote(noteId: string, token: string): Promise<SapNoteDetail | null> {
    logger.info(`📄 Fetching SAP Note: ${noteId}`);

    try {
      // Try Playwright-based raw notes API first (most likely to get actual content)
      try {
        logger.info(`🎭 Trying Playwright approach for note ${noteId}`);
        const note = await this.getNoteWithPlaywright(noteId, token);
        if (note) {
          logger.info(`✅ Retrieved SAP Note ${noteId} via Playwright`);
          return note;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`⚠️ Playwright approach failed: ${errorMessage}, trying HTTP fallbacks`);
      }

      // Try the raw notes API with HTTP (might get redirects)
      try {
        const rawResponse = await this.makeRawRequest(`/Detail?q=${noteId}&t=E&isVTEnabled=false`, token);
        if (rawResponse.ok) {
          const note = await this.parseRawNoteDetail(rawResponse, noteId);
          if (note) {
            logger.info(`✅ Retrieved SAP Note ${noteId} via raw HTTP API`);
            return note;
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug(`Raw notes HTTP API failed: ${errorMessage}, trying OData fallbacks`);
      }

      // Fallback to OData endpoints
      const fallbackEndpoints = [
        `/services/odata/svt/snogwscorr/Notes('${noteId}')?$format=json`,
        `/services/odata/svt/snogwscorr/KnowledgeBaseEntries?$filter=SapNote eq '${noteId}'&$format=json`,
        `/support/notes/${noteId}` // HTML fallback
      ];

      for (const endpoint of fallbackEndpoints) {
        try {
          const response = await this.makeRequest(endpoint, token);
          const note = await this.parseNoteResponse(response, noteId);
          if (note) {
            logger.info(`✅ Retrieved SAP Note ${noteId} via fallback`);
            return note;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`⚠️ Endpoint ${endpoint} failed: ${errorMessage}`);
        }
      }

      logger.warn(`❌ SAP Note ${noteId} not found`);
      return null;

    } catch (error) {
      logger.error(`❌ Failed to get SAP Note ${noteId}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get SAP Note ${noteId}: ${errorMessage}`);
    }
  }

  /**
   * Health check for the SAP Notes API
   */
  async healthCheck(token: string): Promise<boolean> {
    try {
      const response = await this.makeRequest('/services/odata/svt/snogwscorr/$metadata', token);
      return response.ok;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('SAP Notes API health check failed:', errorMessage);
      return false;
    }
  }

  /**
   * Format cookies from cache for direct API calls
   * Ensures proper cookie format for fetch requests
   */
  private async formatCookiesForAPI(sapToken: string): Promise<string> {
    logger.debug(`🔍 ENHANCED DEBUG: Cookie formatting analysis:`);
    logger.debug(`   📊 Input token length: ${sapToken.length}`);
    logger.debug(`   🔧 Contains '=': ${sapToken.includes('=')}`);
    logger.debug(`   📄 First 50 chars: ${sapToken.substring(0, 50)}...`);
    
    // If sapToken is already in proper cookie format (contains '='), use as-is
    if (sapToken.includes('=')) {
      const cookieCount = (sapToken.match(/=/g) || []).length;
      logger.debug(`   ✅ Using input token as-is (${cookieCount} cookies detected)`);
      return sapToken;
    }
    
    // Otherwise, try to get cookies from cache and format them
    try {
      logger.debug(`   🔍 Token not in cookie format, checking cache...`);
      const cookies = await this.getCachedCookies();
      if (cookies.length > 0) {
        const formattedString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        logger.debug(`   ✅ Formatted ${cookies.length} cookies from cache`);
        logger.debug(`   🔧 Key cookies: ${cookies.slice(0, 3).map(c => c.name).join(', ')}...`);
        logger.debug(`   📊 Formatted length: ${formattedString.length}`);
        return formattedString;
      } else {
        logger.debug(`   ⚠️ No cached cookies available`);
      }
    } catch (e) {
      logger.debug(`   ❌ Could not get cached cookies: ${e instanceof Error ? e.message : String(e)}`);
    }
    
    logger.debug(`   📄 Returning input token unchanged`);
    return sapToken;
  }

  /**
   * Get Coveo bearer token using direct API calls (faster, more reliable)
   * Based on network analysis - makes the exact same calls as the browser
   */
  private async getCoveoTokenDirect(sapToken: string): Promise<string> {
    logger.info('🚀 Attempting direct Coveo token API approach');
    
    // Ensure cookies are properly formatted for API calls
    const formattedCookies = await this.formatCookiesForAPI(sapToken);
    
    // Construct knowledge search URL to use as referrer
    const searchParams = JSON.stringify({
      q: 'test',
      tab: 'All',
      f: { documenttype: ['SAP Note'] }
    });
    const referrerUrl = `https://me.sap.com/knowledge/search/${encodeURIComponent(searchParams)}`;
    
    // Common headers based on network analysis
    const commonHeaders = {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'de',
      'X-Requested-With': 'XMLHttpRequest',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': referrerUrl,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Cookie': formattedCookies
    };

    try {
      // Enhanced debugging for direct API approach
      const cookieCount = (formattedCookies.match(/=/g) || []).length;
      logger.debug(`🔍 ENHANCED DEBUG: Direct API approach details:`);
      logger.debug(`   🍪 Using ${cookieCount} cookies for direct API`);
      logger.debug(`   📋 Referrer URL: ${referrerUrl}`);
      logger.debug(`   🔧 Sample cookie names: ${formattedCookies.split(';').slice(0, 5).map(c => c.split('=')[0].trim()).join(', ')}...`);
      logger.debug(`   📊 Cookie string length: ${formattedCookies.length}`);
      logger.debug(`   🌐 Target endpoints:`);
      logger.debug(`      1. https://me.sap.com/backend/raw/core/Applications/coveo`);
      logger.debug(`      2. https://me.sap.com/backend/raw/coveo/CoveoToken`);
      
      // Step 1: Initialize Coveo application first (required prerequisite)
      logger.debug('📋 Step 1: Initializing Coveo application...');
      const appResponse = await fetch('https://me.sap.com/backend/raw/core/Applications/coveo', {
        method: 'GET',
        headers: commonHeaders
      });

      // Enhanced error logging
      if (!appResponse.ok) {
        let errorBody = '';
        try {
          errorBody = await appResponse.text();
        } catch (e) {
          errorBody = 'Could not read error body';
        }
        
        logger.debug(`❌ Direct API Error Details:`);
        logger.debug(`   Status: ${appResponse.status} ${appResponse.statusText}`);
        logger.debug(`   Headers: ${JSON.stringify(Object.fromEntries(appResponse.headers.entries()))}`);
        logger.debug(`   Body: ${errorBody.substring(0, 200)}${errorBody.length > 200 ? '...' : ''}`);
        
        throw new Error(`Coveo app initialization failed: ${appResponse.status} ${appResponse.statusText}. Response: ${errorBody.substring(0, 100)}`);
      }

      const appData = await appResponse.json();
      logger.debug(`✅ Coveo app initialized: ${JSON.stringify(appData).substring(0, 100)}...`);

      // Step 2: Get Coveo token
      logger.debug('🔑 Step 2: Fetching Coveo token...');
      const tokenResponse = await fetch('https://me.sap.com/backend/raw/coveo/CoveoToken', {
        method: 'GET',
        headers: commonHeaders
      });

      if (!tokenResponse.ok) {
        throw new Error(`Coveo token request failed: ${tokenResponse.status} ${tokenResponse.statusText}`);
      }

      const tokenData = await tokenResponse.json();
      
      if (!tokenData.token) {
        throw new Error('Token not found in response');
      }

      logger.info(`✅ Direct API SUCCESS: Retrieved Coveo token (length: ${tokenData.token.length})`);
      return tokenData.token;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`❌ Direct API failed: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Get Coveo bearer token from SAP authentication
   * Primary method - tries direct API first, falls back to Playwright navigation
   */
  private async getCoveoToken(sapToken: string): Promise<string> {
    // Method 1: Try direct API calls first (fastest, most reliable)
    try {
      return await this.getCoveoTokenDirect(sapToken);
    } catch (directError) {
      const directErrorMsg = directError instanceof Error ? directError.message : String(directError);
      logger.warn(`⚠️ Direct API approach failed: ${directErrorMsg}`);
      logger.info('🔄 Falling back to Playwright navigation approach...');
    }

    // Method 2: Fallback to existing Playwright approach
    return await this.getCoveoTokenWithPlaywright(sapToken);
  }

  /**
   * Get Coveo bearer token using Playwright navigation (fallback method)
   * The token is dynamically generated and embedded in the SAP search page
   */
  private async getCoveoTokenWithPlaywright(sapToken: string): Promise<string> {
    logger.debug('🔑 Fetching Coveo bearer token from SAP session using Playwright');
    
    let page: Page | null = null;

    try {
      // Check if we need to close idle browser
      const now = Date.now();
      if (this.browser && (now - this.browserLastUsed > this.BROWSER_IDLE_TIMEOUT)) {
        logger.debug('🧹 Closing idle browser session');
        await this.browser.close().catch(() => {});
        this.browser = null;
        this.browserContext = null;
      }

      // Reuse existing browser session or create new one
      if (!this.browser || !this.browser.isConnected()) {
        logger.debug('🎭 Launching new persistent browser session');
        
        // Detect container environment and force headless mode
        const isDocker = process.env.DOCKER_ENV === 'true' || 
                        process.env.NODE_ENV === 'production' ||
                        !process.env.DISPLAY ||
                        !process.stdin.isTTY ||
                        process.env.CI === 'true';
        
        // Force headless in container/server environments
        const forceHeadless = isDocker || process.platform === 'linux';
        const shouldUseHeadless = forceHeadless || !this.config.headful;
        
        const launchOptions = {
          headless: shouldUseHeadless,
          args: [
            '--disable-dev-shm-usage', 
            '--no-sandbox',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--no-first-run',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
          ]
        };
        
        logger.debug(`🔧 Browser launch configuration:`);
        logger.debug(`   Container detected: ${isDocker}`);
        logger.debug(`   Force headless: ${forceHeadless}`);
        logger.debug(`   Config headful: ${this.config.headful}`);
        logger.debug(`   Final headless: ${shouldUseHeadless}`);
        logger.debug(`   Platform: ${process.platform}`);
        logger.debug(`   Display: ${process.env.DISPLAY || 'NOT_SET'}`);
        logger.debug(`   Launch options: ${JSON.stringify(launchOptions, null, 2)}`);
        
        this.browser = await chromium.launch(launchOptions);

        this.browserContext = await this.browser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        });

        // Add cookies from cached authentication
        const cookies = await this.getCachedCookies();
        if (cookies.length > 0) {
          // Filter out session cookies and log them
          const sessionCookies = cookies.filter(c => c.expires === -1);
          const persistentCookies = cookies.filter(c => c.expires !== -1);
          
          if (sessionCookies.length > 0) {
            logger.warn(`⚠️  Found ${sessionCookies.length} session cookies (may expire): ${sessionCookies.map(c => c.name).join(', ')}`);
          }
          
          await this.browserContext.addCookies(cookies);
          logger.debug(`🍪 Added ${cookies.length} cached cookies (${persistentCookies.length} persistent, ${sessionCookies.length} session)`);
        } else {
          // Fallback to parsing token string
          const parsedCookies = this.parseCookiesFromToken(sapToken);
          if (parsedCookies.length > 0) {
            await this.browserContext.addCookies(parsedCookies);
            logger.debug(`🍪 Added ${parsedCookies.length} parsed cookies to browser context`);
          }
        }
        
        logger.info('✅ Persistent browser session created - session cookies will remain valid');
      } else {
        logger.debug('♻️  Reusing existing browser session (session cookies still valid)');
      }

      this.browserLastUsed = now;
      page = await this.browserContext.newPage();
      
      if (!page) {
        throw new Error('Failed to create browser page');
      }
      
      // Set up response listener to detect redirects to login pages
      let wasRedirectedToLogin = false;
      page.on('response', (response) => {
        const url = response.url();
        if (url.includes('authentication.') || url.includes('saml/login') || url.includes('accounts.sap.com/saml2/idp/sso')) {
          wasRedirectedToLogin = true;
          logger.warn(`⚠️ Detected redirect to authentication page: ${url.substring(0, 80)}...`);
        }
      });

      // Intercept network requests to capture the Coveo token
      let coveoToken: string | null = null;
      
      // Enhanced token capture - monitor both Coveo API calls AND token endpoint
      page.on('request', (request) => {
        const authHeader = request.headers()['authorization'];
        if (authHeader && request.url().includes('coveo.com')) {
          logger.debug(`📡 Coveo request: ${request.url().substring(0, 80)}`);
          logger.debug(`🔑 Auth header: ${authHeader.substring(0, 50)}...`);
          if (authHeader.startsWith('Bearer ')) {
            coveoToken = authHeader.replace('Bearer ', '');
            logger.debug(`🎯 CAPTURED Coveo token from request header (length: ${coveoToken.length})`);
          }
        }
      });

      // Also monitor the direct token endpoint responses with enhanced debugging
      page.on('response', async (response) => {
        if (response.url().includes('/backend/raw/coveo/CoveoToken')) {
          try {
            logger.debug(`🔍 ENHANCED DEBUG: Detected CoveoToken endpoint response`);
            logger.debug(`   📊 Status: ${response.status()} ${response.statusText()}`);
            logger.debug(`   🌐 URL: ${response.url()}`);
            const headersObj: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers())) {
              headersObj[key] = value;
            }
            logger.debug(`   🔧 Headers: ${JSON.stringify(headersObj)}`);            
            
            if (response.ok()) {
              const responseText = await response.text();
              logger.debug(`   📄 Raw response body (first 200 chars): ${responseText.substring(0, 200)}...`);
              
              try {
                const tokenData = JSON.parse(responseText);
                logger.debug(`   🎯 Parsed JSON keys: ${Object.keys(tokenData).join(', ')}`);
                
                if (tokenData.token) {
                  coveoToken = tokenData.token;
                  logger.debug(`   ✅ SUCCESS: Token extracted (length: ${tokenData.token.length})`);
                  logger.debug(`   🔑 Token preview: ${tokenData.token.substring(0, 20)}...${tokenData.token.substring(tokenData.token.length - 20)}`);
                  
                  // Log additional metadata
                  if (tokenData.organizationId) {
                    logger.debug(`   🏢 Organization ID: ${tokenData.organizationId}`);
                  }
                  if (tokenData.clientId) {
                    logger.debug(`   👤 Client ID: ${tokenData.clientId}`);
                  }
                } else {
                  logger.debug(`   ❌ Token field missing from response`);
                }
              } catch (jsonError) {
                logger.debug(`   ❌ JSON parsing failed: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
                logger.debug(`   📄 Response was not valid JSON`);
              }
            } else {
              const errorText = await response.text();
              logger.debug(`   ❌ Error response body: ${errorText}`);
            }
          } catch (error) {
            logger.debug(`⚠️ Could not process CoveoToken response: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        
        // Also log other potentially relevant backend calls for debugging
        if (response.url().includes('/backend/raw/') && response.url().includes('coveo')) {
          logger.debug(`🔍 Other Coveo-related call: ${response.status()} ${response.url()}`);
        }
      });

      // First, go to the home page to ensure we're fully authenticated
      logger.debug(`🌐 Navigating to SAP home page first...`);
      let response;
      
      try {
        response = await page.goto('https://me.sap.com/home', {
          waitUntil: 'load',  // Wait for page load
          timeout: 30000  // Reduce timeout to 30s
        });
        logger.debug(`📊 Home page loaded: ${response?.status()} - ${page.url().substring(0, 100)}...`);
      } catch (gotoError) {
        logger.warn(`⚠️ Home page navigation timeout/error, trying direct search page: ${gotoError instanceof Error ? gotoError.message : String(gotoError)}`);
        // Continue anyway - maybe direct navigation to search will work
      }

      // Check if we were redirected to login page
      const currentUrl = page.url();
      if (wasRedirectedToLogin || currentUrl.includes('authentication.') || currentUrl.includes('saml/login')) {
        logger.error('❌ Session expired or cookies invalid - redirected to login page');
        logger.error('💡 Please run fresh authentication to update cached cookies');
        throw new Error('Session expired - authentication required. Run test:auth to refresh credentials.');
      }

      // Enhanced debugging for page state and timing
      logger.debug(`🔍 ENHANCED DEBUG: Current page analysis:`);
      logger.debug(`   📄 Title: "${await page.title()}"`);
      logger.debug(`   🌐 URL: ${page.url()}`);
      logger.debug(`   🍪 Cookies count: ${(await page.context().cookies()).length}`);
      
      // Check if token might already be available in page context
      const pageState = await page.evaluate(() => {
        return {
          hasWindow: typeof window !== 'undefined',
          hasCoveoInWindow: Object.keys(window).filter(k => k.toLowerCase().includes('cove')).length > 0,
          windowKeys: Object.keys(window).length,
          documentReady: document.readyState,
          locationHref: location.href,
          userAgent: navigator.userAgent
        };
      });
      
      logger.debug(`   🔧 Page context: ${JSON.stringify(pageState, null, 2)}`);
      
      // Wait for any initialization with enhanced timing logs
      logger.debug(`⏳ ENHANCED DEBUG: Waiting for page initialization...`);
      await page.waitForTimeout(2000);
      
      // Navigate directly to a search page that will trigger the CoveoToken endpoint
      // Based on Docker logs, this endpoint gets called during home page initialization
      logger.debug(`🎯 ENHANCED DEBUG: Looking for Coveo token in current page context...`);
      
      // The token endpoint might already have been called during home page load
      // If not, navigate to search page to trigger it
      if (!coveoToken) {
        const searchParams = JSON.stringify({
          q: 'mm22',  // Use actual search term that works
          tab: 'All',
          f: { documenttype: ['SAP Note'] }
        });
        const searchPageUrl = `https://me.sap.com/knowledge/search/${encodeURIComponent(searchParams)}`;
        logger.debug(`🌐 Navigating to knowledge search to trigger CoveoToken: ${searchPageUrl.substring(0, 100)}...`);

        try {
          response = await page.goto(searchPageUrl, {
            waitUntil: 'networkidle',  // Wait for network to settle
            timeout: 45000  // Increase timeout for Docker
          });
          logger.debug(`📊 Search page loaded: ${response?.status()} - ${page.url().substring(0, 100)}...`);
        } catch (searchGotoError) {
          logger.warn(`⚠️ Search page navigation had issues: ${searchGotoError instanceof Error ? searchGotoError.message : String(searchGotoError)}`);
          // Continue anyway - token might have been captured already
        }

        // Give more time for all network requests to complete (especially in Docker)
        logger.debug(`⏳ Waiting for network activity and token generation...`);
        await page.waitForTimeout(5000);
      }
      
      logger.debug(`🔍 Final token capture status: ${coveoToken ? 'YES' : 'NO'}`);

      // Try direct API calls from within the browser context (hybrid approach)
      if (!coveoToken) {
        logger.debug('🔧 Attempting hybrid approach: direct API calls from browser context');
        
        try {
          const browserToken = await page.evaluate(async () => {
            try {
              console.log('🔧 Browser Context: Starting direct API calls...');
              
              // Step 1: Initialize Coveo application
              console.log('📋 Browser Context: Calling /backend/raw/core/Applications/coveo...');
              const appResponse = await fetch('/backend/raw/core/Applications/coveo', {
                method: 'GET',
                headers: {
                  'Accept': 'application/json, text/javascript, */*; q=0.01',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                credentials: 'include'
              });
              
              console.log(`📊 Browser Context: App response - ${appResponse.status} ${appResponse.statusText}`);
              
              if (appResponse.ok) {
                const appData = await appResponse.json();
                console.log(`✅ Browser Context: App initialized - ${JSON.stringify(appData).substring(0, 100)}...`);
                
                // Step 2: Get Coveo token
                console.log('🔑 Browser Context: Calling /backend/raw/coveo/CoveoToken...');
                const tokenResponse = await fetch('/backend/raw/coveo/CoveoToken', {
                  method: 'GET', 
                  headers: {
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  credentials: 'include'
                });
                
                console.log(`📊 Browser Context: Token response - ${tokenResponse.status} ${tokenResponse.statusText}`);
                
                if (tokenResponse.ok) {
                  const tokenData = await tokenResponse.json();
                  console.log(`🎯 Browser Context: Token data keys - ${Object.keys(tokenData).join(', ')}`);
                  console.log(`🔑 Browser Context: Token found - ${tokenData.token ? 'YES' : 'NO'} (length: ${tokenData.token?.length || 0})`);
                  return tokenData.token || null;
                } else {
                  const errorText = await tokenResponse.text();
                  console.log(`❌ Browser Context: Token request failed - ${errorText}`);
                }
              } else {
                const errorText = await appResponse.text();
                console.log(`❌ Browser Context: App request failed - ${errorText}`);
              }
              return null;
            } catch (error) {
              console.log(`❌ Browser Context: Exception - ${error instanceof Error ? error.message : String(error)}`);
              return null;
            }
          });
          
          if (browserToken) {
            coveoToken = browserToken;
            logger.debug(`🎯 CAPTURED Coveo token via browser context API (length: ${browserToken.length})`);
          } else {
            logger.debug('⚠️ Browser context API calls did not return token');
          }
        } catch (error) {
          logger.debug(`⚠️ Browser context API approach failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Fallback: Try to extract token from page JavaScript context
      if (!coveoToken) {
        logger.debug('🔍 Final fallback: Attempting to extract Coveo token from page JavaScript');
        
        const tokenData = await page.evaluate(() => {
          // Look for Coveo token in window object
          const win = window as any;
          const findings: any = {
            token: null,
            foundIn: null,
            windowKeys: Object.keys(win).filter(k => k.toLowerCase().includes('cove')).slice(0, 5)
          };
          
          // Common places where Coveo token might be stored
          if (win.coveoToken) {
            findings.token = win.coveoToken;
            findings.foundIn = 'window.coveoToken';
            return findings;
          }
          if (win.Coveo?.SearchEndpoint?.options?.accessToken) {
            findings.token = win.Coveo.SearchEndpoint.options.accessToken;
            findings.foundIn = 'window.Coveo.SearchEndpoint.options.accessToken';
            return findings;
          }
          if (win.__COVEO_TOKEN__) {
            findings.token = win.__COVEO_TOKEN__;
            findings.foundIn = 'window.__COVEO_TOKEN__';
            return findings;
          }
          
          // Try to find in localStorage
          try {
            const token = localStorage.getItem('coveo_token') || localStorage.getItem('coveoToken');
            if (token) {
              findings.token = token;
              findings.foundIn = 'localStorage';
              return findings;
            }
          } catch (e) {}
          
          // Try to find in sessionStorage
          try {
            const token = sessionStorage.getItem('coveo_token') || sessionStorage.getItem('coveoToken');
            if (token) {
              findings.token = token;
              findings.foundIn = 'sessionStorage';
              return findings;
            }
          } catch (e) {}
          
          return findings;
        });

        if (tokenData.token) {
          coveoToken = tokenData.token;
          logger.debug(`✅ Found Coveo token in: ${tokenData.foundIn}`);
        } else {
          logger.debug(`⚠️ Coveo token not found. Window keys with 'cove': ${tokenData.windowKeys.join(', ')}`);
        }
      }

      if (coveoToken) {
        logger.debug(`✅ Successfully extracted Coveo token (length: ${coveoToken.length})`);
        return coveoToken;
      }

      throw new Error('Unable to extract Coveo token from SAP search page');
      
    } catch (error) {
      logger.error('❌ Failed to get Coveo token:', error);
      
      // If session expired, throw special error and close browser to force re-auth
      if (error instanceof Error && error.message.includes('Session expired')) {
        logger.warn('🔄 Session expired detected - closing browser to force fresh authentication');
        if (this.browser) {
          await this.browser.close().catch(() => {});
          this.browser = null;
          this.browserContext = null;
        }
        throw new Error('SESSION_EXPIRED');
      }
      
      throw new Error(`Failed to get Coveo bearer token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      // Only close the page, keep browser alive for session cookie persistence
      if (page) {
        await page.close().catch(() => {});
      }
      // DON'T close the browser - we need to keep session cookies alive
      // Browser will be closed after BROWSER_IDLE_TIMEOUT or on explicit cleanup
    }
  }
  
  /**
   * Cleanup method - call this when shutting down the server
   */
  async cleanup(): Promise<void> {
    if (this.browser) {
      logger.debug('🧹 Closing persistent browser session');
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.browserContext = null;
    }
  }

  /**
   * Search via SAP internal APIs (fallback when Coveo fails)
   */
  private async searchViaInternalAPI(query: string, token: string, maxResults: number): Promise<SapNoteResult[]> {
    logger.info(`🔍 Internal API: Searching for "${query}" with multiple endpoint strategies`);
    
    const searchEndpoints = [
      // Try current knowledge search endpoint (modern API)
      `/knowledge/search/${encodeURIComponent(JSON.stringify({
        q: query,
        tab: 'Support',
        f: [{ field: 'documenttype', value: ['SAP Note'] }]
      }))}`,
      
      // Try simplified search endpoint
      `/support/search?q=${encodeURIComponent(query)}&type=note&format=json`,
      
      // Try backend notes API (used by note retrieval)
      `/backend/raw/sapnotes/Search?q=${encodeURIComponent(query)}&t=E&maxResults=${maxResults}`
    ];
    
    for (let i = 0; i < searchEndpoints.length; i++) {
      const endpoint = searchEndpoints[i];
      try {
        logger.info(`🌐 Internal API Strategy ${i + 1}/${searchEndpoints.length}: ${endpoint.substring(0, 80)}...`);
        const response = await this.makeRequest(endpoint, token);
        
        logger.debug(`📊 Response status: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
          const results = await this.parseInternalSearchResponse(response, query);
          if (results && results.length > 0) {
            logger.info(`✅ Internal API Strategy ${i + 1} SUCCESS: Found ${results.length} results`);
            return results.slice(0, maxResults);
          } else {
            logger.debug(`📝 Internal API Strategy ${i + 1}: No results found`);
          }
        } else {
          logger.warn(`❌ Internal API Strategy ${i + 1}: HTTP ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        logger.warn(`❌ Internal API Strategy ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    
    logger.warn('❌ All internal API strategies failed - no results found');
    return [];
  }

  /**
   * Parse response from internal SAP search APIs
   */
  private async parseInternalSearchResponse(response: Response, query: string): Promise<SapNoteResult[]> {
    try {
      const contentType = response.headers.get('content-type') || '';
      logger.debug(`📄 Parsing response with content-type: ${contentType}`);
      
      if (contentType.includes('application/json')) {
        const data = await response.json();
        logger.debug(`📊 JSON response keys: ${Object.keys(data).join(', ')}`);
        
        // Handle modern SAP backend raw API responses (similar to note retrieval)
        if (data.Response && data.Response.SearchResults) {
          const results = data.Response.SearchResults.results || data.Response.SearchResults;
          if (Array.isArray(results)) {
            logger.debug(`✅ Found ${results.length} results in modern backend format`);
            return results.map((item: any) => ({
              id: item.Number || item.id || 'unknown',
              title: item.Title || item.title || 'No title',
              summary: item.Summary || item.summary || 'No summary available',
              component: item.Component || undefined,
              releaseDate: item.ReleaseDate || new Date().toISOString(),
              language: item.Language || 'EN',
              url: `https://launchpad.support.sap.com/#/notes/${item.Number || item.id}`
            }));
          }
        }
        
        // Handle knowledge search API responses
        if (data.results && Array.isArray(data.results)) {
          logger.debug(`✅ Found ${data.results.length} results in knowledge search format`);
          return data.results.map((item: any) => ({
            id: item.mh_id || item.id || item.noteId || 'unknown',
            title: item.title || item.mh_description || 'No title',
            summary: item.summary || item.description || item.mh_description || 'No summary available',
            component: item.mh_app_component || item.component || undefined,
            releaseDate: item.date || new Date().toISOString(),
            language: item.language || 'EN',
            url: item.mh_alt_url || `https://launchpad.support.sap.com/#/notes/${item.mh_id || item.id}`
          }));
        }
        
        // Handle simple arrays
        if (Array.isArray(data)) {
          logger.debug(`✅ Found ${data.length} results in simple array format`);
          return data.map((item: any) => ({
            id: item.id || item.noteId || item.Number || 'unknown',
            title: item.title || item.name || item.Title || 'No title',
            summary: item.summary || item.description || item.Summary || 'No summary available',
            component: item.component || undefined,
            releaseDate: item.date || item.ReleaseDate || new Date().toISOString(),
            language: item.language || item.Language || 'EN',
            url: `https://launchpad.support.sap.com/#/notes/${item.id || item.noteId || item.Number}`
          }));
        }
        
        logger.debug(`⚠️ Unrecognized JSON format - trying to extract note IDs`);
      } else if (contentType.includes('text/html')) {
        // Try to parse HTML search results (basic extraction)
        const html = await response.text();
        logger.debug(`📄 Parsing HTML response (length: ${html.length})`);
        return this.parseHTMLSearchResults(html, query);
      } else {
        logger.debug(`⚠️ Unsupported content type: ${contentType}`);
      }
      
      return [];
    } catch (error) {
      logger.warn(`❌ Failed to parse internal API response: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Basic HTML parsing for search results (fallback)
   */
  private parseHTMLSearchResults(html: string, query: string): SapNoteResult[] {
    // This is a basic implementation - could be enhanced with proper HTML parsing
    const results: SapNoteResult[] = [];
    
    // Look for note ID patterns in the HTML
    const noteIdMatches = html.match(/\b\d{6,8}\b/g);
    if (noteIdMatches) {
      const uniqueIds = [...new Set(noteIdMatches)];
      results.push(...uniqueIds.slice(0, 5).map(id => ({
        id,
        title: `SAP Note ${id}`,
        summary: `Found note ID ${id} in search results for "${query}"`,
        component: undefined,
        releaseDate: new Date().toISOString(),
        language: 'EN',
        url: `https://launchpad.support.sap.com/#/notes/${id}`
      })));
    }
    
    return results;
  }

  /**
   * Build Coveo search request body
   */
  private buildCoveoSearchBody(query: string, maxResults: number): any {
    return {
      locale: 'en-US',
      debug: false,
      tab: 'All',
      referrer: 'SAP for Me search interface',
      timezone: 'Europe/Berlin',
      q: query,
      enableQuerySyntax: false,
      searchHub: 'SAP for Me',
      sortCriteria: 'relevancy',
      numberOfResults: maxResults,
      firstResult: 0,
      fieldsToInclude: [
        'author', 'language', 'urihash', 'objecttype', 'collection', 'source',
        'permanentid', 'documenttype', 'date', 'mh_description', 'mh_id',
        'mh_product', 'mh_app_component', 'mh_alt_url', 'mh_category',
        'mh_revisions', 'mh_other_components', 'mh_all_hierarchical_component',
        'file_type', 'mh_priority'
      ],
      facets: [
        {
          field: 'documenttype',
          type: 'specific',
          currentValues: [
            { value: 'SAP Note', state: 'selected' }
          ],
          numberOfValues: 10
        }
      ],
      queryCorrection: {
        enabled: true,
        options: {
          automaticallyCorrect: 'never'
        }
      },
      enableDidYouMean: false
    };
  }

  /**
   * Parse Coveo search response to our SAP Note format
   */
  private parseCoveoResponse(data: any): SapNoteResult[] {
    const results: SapNoteResult[] = [];

    if (!data.results || !Array.isArray(data.results)) {
      logger.warn('⚠️ No results array in Coveo response');
      return results;
    }

    logger.debug(`📄 Parsing ${data.results.length} Coveo results...`);

    for (const item of data.results) {
      try {
        // Extract note ID from raw.mh_id (primary) or fallback to parsing
        const noteId = item.raw?.mh_id || 
                      item.raw?.permanentid?.match(/\d{6,8}/)?.[0] || 
                      item.title?.match(/\d{6,8}/)?.[0] ||
                      'unknown';

        // Extract language (Coveo returns array like ["English"])
        const languageArray = item.raw?.language || item.raw?.syslanguage || [];
        const language = Array.isArray(languageArray) ? languageArray[0] : (languageArray || 'EN');
        
        // Extract component (Coveo returns array, take first element)
        const componentArray = item.raw?.mh_app_component || item.raw?.mh_all_hierarchical_component || [];
        const component = Array.isArray(componentArray) ? componentArray[0] : componentArray;

        // Format release date from timestamp (milliseconds)
        const releaseDate = item.raw?.date ? 
          new Date(item.raw.date).toISOString().split('T')[0] : 
          'Unknown';

        const result: SapNoteResult = {
          id: noteId,
          title: item.title || 'Unknown Title',
          summary: item.excerpt || item.raw?.mh_description || 'No summary available',
          language: language,
          releaseDate: releaseDate,
          component: component,
          url: item.raw?.mh_alt_url || item.clickUri || `https://launchpad.support.sap.com/#/notes/${noteId}`
        };

        logger.debug(`  ✓ Parsed note ${noteId}: ${item.title?.substring(0, 60)}...`);
        results.push(result);
      } catch (err) {
        logger.warn(`⚠️ Failed to parse Coveo result item: ${err}`);
      }
    }

    logger.debug(`✅ Successfully parsed ${results.length} SAP Notes from Coveo response`);
    return results;
  }

  /**
   * Make HTTP request to SAP API
   */
  private async makeRequest(endpoint: string, token: string): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    
    logger.debug(`🌐 Making request to: ${url}`);

    const osUA = (() => {
      const platform = process.platform;
      if (platform === 'win32') return 'Windows NT 10.0; Win64; x64';
      if (platform === 'linux') return 'X11; Linux x86_64';
      return 'Macintosh; Intel Mac OS X 10_15_7';
    })();

    const headers: Record<string, string> = {
      'Cookie': token,
      'User-Agent': `Mozilla/5.0 (${osUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`,
      'Accept': 'application/json, text/html, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    };

    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow' // Follow redirects to handle SAP authentication flow
    });

    logger.debug(`📊 Response: ${response.status} ${response.statusText}`);

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
    }

    return response;
  }


  /**
   * Parse note detail response
   */
  private async parseNoteResponse(response: Response, noteId: string): Promise<SapNoteDetail | null> {
    const responseText = await response.text();
    
    // Try JSON first
    try {
      const jsonData = JSON.parse(responseText);
      
      if (jsonData.d) {
        return this.mapToSapNoteDetail(jsonData.d, noteId);
      }
    } catch (jsonError) {
      // Try HTML parsing
      logger.debug('Note response is not JSON, attempting HTML parsing');
    }

    // Parse HTML for note details
    return this.parseHtmlForNoteDetail(responseText, noteId);
  }


  /**
   * Map OData result to our SapNoteDetail format
   */
  private mapToSapNoteDetail(item: any, noteId: string): SapNoteDetail {
    return {
      id: item.SapNote || item.Id || item.id || noteId,
      title: item.Title || item.title || 'Unknown Title',
      summary: item.Summary || item.summary || item.Description || 'No summary available',
      content: item.Content || item.content || item.Text || item.summary || 'Content not available',
      language: item.Language || item.language || 'EN',
      releaseDate: item.ReleaseDate || item.releaseDate || item.CreationDate || 'Unknown',
      component: item.Component || item.component,
      priority: item.Priority || item.priority,
      category: item.Category || item.category,
      url: `https://launchpad.support.sap.com/#/notes/${noteId}`
    };
  }


  /**
   * Parse HTML response to extract note details
   */
  private parseHtmlForNoteDetail(html: string, noteId: string): SapNoteDetail | null {
    // Extract title if available
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/SAP\s*-?\s*/i, '').trim() : `SAP Note ${noteId}`;
    
    return {
      id: noteId,
      title,
      summary: 'SAP Note details available at the provided URL',
      content: 'Please visit the URL for complete note content',
      language: 'EN',
      releaseDate: 'Unknown',
      url: `https://launchpad.support.sap.com/#/notes/${noteId}`
    };
  }

  /**
   * Make HTTP request to SAP Raw Notes API (me.sap.com)
   */
  private async makeRawRequest(endpoint: string, token: string): Promise<Response> {
    const url = `${this.rawNotesUrl}${endpoint}`;
    
    logger.debug(`🌐 Making raw request to: ${url}`);

    // Use browser-like headers (no XMLHttpRequest to avoid 401)
    const osUA2 = (() => {
      const platform = process.platform;
      if (platform === 'win32') return 'Windows NT 10.0; Win64; x64';
      if (platform === 'linux') return 'X11; Linux x86_64';
      return 'Macintosh; Intel Mac OS X 10_15_7';
    })();

    const headers: Record<string, string> = {
      'Cookie': token,
      'User-Agent': `Mozilla/5.0 (${osUA2}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://me.sap.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1'
    };

    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow' // Follow redirects to get to actual content
    });

    logger.debug(`📊 Raw response: ${response.status} ${response.statusText} (${response.url})`);

    // For raw notes API, even redirects might be useful
    if (!response.ok && response.status !== 404 && response.status !== 302 && response.status !== 301) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
    }

    return response;
  }


  /**
   * Parse raw note response for detailed note information
   */
  private async parseRawNoteDetail(response: Response, noteId: string): Promise<SapNoteDetail | null> {
    const responseText = await response.text();
    
    try {
      const jsonData = JSON.parse(responseText);
      
      // Check if we have a valid note response
      if (jsonData && (jsonData.SapNote || jsonData.id || jsonData.noteId)) {
        return {
          id: jsonData.SapNote || jsonData.id || jsonData.noteId || noteId,
          title: jsonData.Title || jsonData.title || jsonData.ShortText || `SAP Note ${noteId}`,
          summary: jsonData.Summary || jsonData.summary || jsonData.Abstract || jsonData.abstract || 'SAP Note details',
          content: jsonData.Content || jsonData.content || jsonData.Text || jsonData.LongText || jsonData.Html || 'Note content available at URL',
          language: jsonData.Language || jsonData.language || 'EN',
          releaseDate: jsonData.ReleaseDate || jsonData.releaseDate || jsonData.CreationDate || 'Unknown',
          component: jsonData.Component || jsonData.component,
          priority: jsonData.Priority || jsonData.priority,
          category: jsonData.Category || jsonData.category || jsonData.Type,
          url: `https://launchpad.support.sap.com/#/notes/${noteId}`
        };
      }
    } catch (jsonError) {
      logger.debug('Raw note response is not JSON, checking for HTML redirect/content');
    }

    // Check if this is a redirect page that indicates the note exists
    if (responseText.includes('fragmentAfterLogin') || responseText.includes('document.cookie')) {
      logger.debug('Detected redirect page, note likely exists but requires browser navigation');
      
      // If we got a response for a valid note ID, create a basic result
      if (noteId && noteId.match(/^\d{6,8}$/)) {
        return {
          id: noteId,
          title: `SAP Note ${noteId}`,
          summary: 'Note found via raw API - full content requires browser access',
          content: `This SAP Note exists but its content requires browser navigation to access.\n\nTo view the complete note content:\n1. Visit: https://launchpad.support.sap.com/#/notes/${noteId}\n2. Or access through: https://me.sap.com with your SAP credentials\n\nThe note was successfully located but content extraction requires additional authentication steps.`,
          language: 'EN',
          releaseDate: 'Unknown',
          url: `https://launchpad.support.sap.com/#/notes/${noteId}`
        };
      }
    }

    // Fallback to HTML parsing
    return this.parseHtmlForNoteDetail(responseText, noteId);
  }

  /**
   * Get SAP Note details using Playwright to handle authentication and JavaScript
   */
  private async getNoteWithPlaywright(noteId: string, token: string): Promise<SapNoteDetail | null> {
    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
      logger.debug(`🎭 Launching browser for note ${noteId}`);
      
      // Detect container environment and force headless mode
      const isDocker = process.env.DOCKER_ENV === 'true' || 
                      process.env.NODE_ENV === 'production' ||
                      !process.env.DISPLAY ||
                      !process.stdin.isTTY ||
                      process.env.CI === 'true';
      
      // Force headless in container/server environments
      const forceHeadless = isDocker || process.platform === 'linux';
      const shouldUseHeadless = forceHeadless || !this.config.headful;
      
      const launchOptions = {
        headless: shouldUseHeadless,
        args: [
          '--disable-dev-shm-usage', 
          '--no-sandbox',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--no-first-run',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      };
      
      logger.debug(`🔧 Note browser launch configuration:`);
      logger.debug(`   Note ID: ${noteId}`);
      logger.debug(`   Container detected: ${isDocker}`);
      logger.debug(`   Force headless: ${forceHeadless}`);
      logger.debug(`   Config headful: ${this.config.headful}`);
      logger.debug(`   Final headless: ${shouldUseHeadless}`);
      logger.debug(`   Platform: ${process.platform}`);
      logger.debug(`   Display: ${process.env.DISPLAY || 'NOT_SET'}`);
      logger.debug(`   Launch options: ${JSON.stringify(launchOptions, null, 2)}`);
      
      // Launch browser
      browser = await chromium.launch(launchOptions);

      // Create context and add cookies
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      });

      // Get cookies from the cached authentication
      const cookies = await this.getCachedCookies();
      if (cookies.length > 0) {
        await context.addCookies(cookies);
        logger.debug(`🍪 Added ${cookies.length} cached cookies to browser context`);
      } else {
        // Fallback to parsing token string if no cached cookies
        const parsedCookies = this.parseCookiesFromToken(token);
        if (parsedCookies.length > 0) {
          await context.addCookies(parsedCookies);
          logger.debug(`🍪 Added ${parsedCookies.length} parsed cookies to browser context`);
        }
      }

      page = await context.newPage();

      // Navigate to the raw notes endpoint
      const rawUrl = `https://me.sap.com/backend/raw/sapnotes/Detail?q=${noteId}&t=E&isVTEnabled=false`;
      logger.debug(`🌐 Navigating to: ${rawUrl}`);

      const response = await page.goto(rawUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      if (!response || !response.ok()) {
        throw new Error(`HTTP ${response?.status()}: Failed to load page`);
      }

      // Wait a bit for any JavaScript to execute
      await page.waitForTimeout(2000);

      // Get page content and check what we received
      const content = await page.content();
      const pageTitle = await page.title();
      const currentUrl = page.url();
      
      logger.debug(`📄 Page loaded - Title: "${pageTitle}", URL: ${currentUrl}`);
      logger.debug(`📄 Content length: ${content.length} characters`);
      
      // Log first few lines of content for debugging
      const contentPreview = content.substring(0, 500);
      logger.debug(`📄 Content preview: ${contentPreview}`);
      
      // Check if page contains JSON data in body text
      try {
        // First, try to get text content from body
        const bodyText = await page.locator('body').textContent();
        if (bodyText) {
          logger.debug(`📊 Body text length: ${bodyText.length}`);
          
          // Try to parse body text as JSON
          const trimmedBodyText = bodyText.trim();
                     if (trimmedBodyText.startsWith('{') && trimmedBodyText.endsWith('}')) {
             const jsonData = JSON.parse(trimmedBodyText);
             logger.info(`🎉 Successfully parsed JSON from page body!`);
             logger.debug(`📊 JSON keys: ${Object.keys(jsonData).join(', ')}`);
             
             // Handle the actual SAP Note API response structure
             if (jsonData.Response && jsonData.Response.SAPNote) {
               const sapNote = jsonData.Response.SAPNote;
               const header = sapNote.Header || {};
               
               logger.info(`📄 Extracting SAP Note data from API response`);
               
               return {
                 id: header.Number?.value || noteId,
                 title: sapNote.Title?.value || `SAP Note ${noteId}`,
                 summary: header.Type?.value || 'SAP Knowledge Base Article',
                 content: sapNote.LongText?.value || 'No content available',
                 language: header.Language?.value || 'EN',
                 releaseDate: header.ReleasedOn?.value || 'Unknown',
                 component: header.SAPComponentKeyText?.value || header.SAPComponentKey?.value,
                 priority: header.Priority?.value,
                 category: header.Category?.value,
                 url: `https://launchpad.support.sap.com/#/notes/${noteId}`
               };
             }
             
             // Fallback to generic JSON parsing for other structures
             return {
               id: jsonData.SapNote || jsonData.id || noteId,
               title: jsonData.Title || jsonData.title || jsonData.ShortText || `SAP Note ${noteId}`,
               summary: jsonData.Summary || jsonData.summary || jsonData.Abstract || jsonData.Description || 'Note content extracted via Playwright',
               content: jsonData.Content || jsonData.content || jsonData.Text || jsonData.LongText || jsonData.Html || jsonData.Description || 'Raw note data retrieved successfully',
               language: jsonData.Language || 'EN',
               releaseDate: jsonData.ReleaseDate || jsonData.CreationDate || 'Unknown',
               component: jsonData.Component,
               priority: jsonData.Priority,
               category: jsonData.Category || jsonData.Type,
               url: `https://launchpad.support.sap.com/#/notes/${noteId}`
             };
           }
        }
      } catch (jsonError) {
        const errorMessage = jsonError instanceof Error ? jsonError.message : String(jsonError);
        logger.debug(`JSON parsing failed: ${errorMessage}`);
      }
      
      // Check if the entire page content is JSON
      try {
        const jsonMatch = content.match(/<body[^>]*>(.*?)<\/body>/s);
                 if (jsonMatch && jsonMatch[1]) {
           const bodyContent = jsonMatch[1].trim();
           if (bodyContent.startsWith('{') && bodyContent.endsWith('}')) {
             const jsonData = JSON.parse(bodyContent);
             logger.info(`🎉 Found JSON in HTML body!`);
             
             // Handle the actual SAP Note API response structure
             if (jsonData.Response && jsonData.Response.SAPNote) {
               const sapNote = jsonData.Response.SAPNote;
               const header = sapNote.Header || {};
               
               logger.info(`📄 Extracting SAP Note data from HTML body API response`);
               
               return {
                 id: header.Number?.value || noteId,
                 title: sapNote.Title?.value || `SAP Note ${noteId}`,
                 summary: header.Type?.value || 'SAP Knowledge Base Article',
                 content: sapNote.LongText?.value || 'No content available',
                 language: header.Language?.value || 'EN',
                 releaseDate: header.ReleasedOn?.value || 'Unknown',
                 component: header.SAPComponentKeyText?.value || header.SAPComponentKey?.value,
                 priority: header.Priority?.value,
                 category: header.Category?.value,
                 url: `https://launchpad.support.sap.com/#/notes/${noteId}`
               };
             }
             
             // Fallback to generic JSON parsing
             return {
               id: jsonData.SapNote || jsonData.id || noteId,
               title: jsonData.Title || jsonData.title || jsonData.ShortText || `SAP Note ${noteId}`,
               summary: jsonData.Summary || jsonData.summary || jsonData.Abstract || 'Note extracted via Playwright',
               content: jsonData.Content || jsonData.content || jsonData.Text || jsonData.LongText || jsonData.Html || 'Note content available',
               language: jsonData.Language || 'EN',
               releaseDate: jsonData.ReleaseDate || jsonData.CreationDate || 'Unknown',
               component: jsonData.Component,
               priority: jsonData.Priority,
               category: jsonData.Category || jsonData.Type,
               url: `https://launchpad.support.sap.com/#/notes/${noteId}`
             };
           }
         }
      } catch (htmlJsonError) {
        logger.debug('No JSON found in HTML body either');
      }

      // If no JSON, try to extract data from HTML
      logger.debug(`📄 Parsing HTML content (${content.length} characters)`);
      
      // Look for note data in various places in the HTML
      const noteData = await page.evaluate((noteId) => {
        // Try to find note information in the page
        const result = {
          id: noteId,
          title: '',
          summary: '',
          content: '',
          found: false
        };

        // Look for title in various places
        const titleElement = document.querySelector('h1, h2, .note-title, .title');
        if (titleElement) {
          result.title = titleElement.textContent?.trim() || '';
          result.found = true;
        }

        // Look for content in various places
        const contentElement = document.querySelector('.note-content, .content, .description, .text');
        if (contentElement) {
          result.content = contentElement.textContent?.trim() || '';
          result.found = true;
        }

        // Look for summary
        const summaryElement = document.querySelector('.summary, .abstract, .description');
        if (summaryElement) {
          result.summary = summaryElement.textContent?.trim() || '';
          result.found = true;
        }

        // If we found any content, mark as successful
        if (result.title || result.content || result.summary) {
          result.found = true;
        }

        return result;
      }, noteId);

      if (noteData.found) {
        logger.info(`📄 Extracted note data from HTML via Playwright`);
        
        return {
          id: noteId,
          title: noteData.title || `SAP Note ${noteId}`,
          summary: noteData.summary || 'Extracted via Playwright',
          content: noteData.content || 'Note content extracted via browser automation',
          language: 'EN',
          releaseDate: 'Unknown',
          url: `https://launchpad.support.sap.com/#/notes/${noteId}`
        };
      }

      // If we get here, we didn't find useful content
      logger.warn(`⚠️ Playwright loaded page but couldn't extract note content`);
      return null;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Playwright note extraction failed: ${errorMessage}`);
      throw new Error(`Playwright extraction failed: ${errorMessage}`);
    } finally {
      // Cleanup
      if (page) {
        await page.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  /**
   * Parse cookies from token string
   */
  private parseCookiesFromToken(token: string): Array<{name: string, value: string, domain: string, path: string}> {
    const cookies: Array<{name: string, value: string, domain: string, path: string}> = [];
    
    try {
      // Split by semicolon and parse each cookie
      const cookiePairs = token.split(';');
      
      for (const pair of cookiePairs) {
        const trimmed = pair.trim();
        if (trimmed && trimmed.includes('=')) {
          const equalIndex = trimmed.indexOf('=');
          const name = trimmed.substring(0, equalIndex).trim();
          let value = trimmed.substring(equalIndex + 1).trim();
          
          // Remove surrounding quotes if present
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          
          // Only add valid cookies with proper names and values
          if (name && value && name.length > 0 && value.length > 0) {
            // Skip cookie attributes like Path, Domain, Secure, HttpOnly
            if (!['path', 'domain', 'secure', 'httponly', 'samesite', 'max-age', 'expires'].includes(name.toLowerCase())) {
              cookies.push({
                name: name,
                value: value,
                domain: '.sap.com',
                path: '/'
              });
            }
          }
        }
      }
      
      logger.debug(`🍪 Parsed ${cookies.length} cookies from token`);
      
      // Log first few cookie names for debugging
      if (cookies.length > 0) {
        const cookieNames = cookies.slice(0, 5).map(c => c.name).join(', ');
        logger.debug(`🍪 Cookie names: ${cookieNames}${cookies.length > 5 ? '...' : ''}`);
      }
      
    } catch (error) {
      logger.warn(`⚠️ Failed to parse cookies from token: ${error}`);
    }
    
    return cookies;
  }

  /**
   * Get cached cookies from the token cache file
   */
  private async getCachedCookies(): Promise<Array<{name: string, value: string, domain: string, path: string, expires?: number, secure?: boolean, httpOnly?: boolean, sameSite?: 'Strict' | 'Lax' | 'None'}>> {
    try {
      const { readFileSync, existsSync } = await import('fs');
      const { dirname, join } = await import('path');
      const { fileURLToPath } = await import('url');
      
      // Get the project root directory
      const currentDir = process.cwd();
      const tokenCacheFile = join(currentDir, 'token-cache.json');
      
      if (!existsSync(tokenCacheFile)) {
        logger.debug('No token cache file found');
        return [];
      }
      
      const tokenCache = JSON.parse(readFileSync(tokenCacheFile, 'utf8'));
      
      if (tokenCache.cookies && Array.isArray(tokenCache.cookies)) {
        logger.debug(`📄 Found ${tokenCache.cookies.length} cached cookies`);
        return tokenCache.cookies;
      }
      
      logger.debug('No cookies array found in token cache');
      return [];
      
    } catch (error) {
      logger.warn(`⚠️ Failed to read cached cookies: ${error}`);
      return [];
    }
  }
} 