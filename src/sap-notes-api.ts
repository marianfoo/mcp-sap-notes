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
      // Get Coveo bearer token from SAP authentication
      const coveoToken = await this.getCoveoToken(token);
      
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
   * Get Coveo bearer token from SAP authentication
   * The token is dynamically generated and embedded in the SAP search page
   */
  private async getCoveoToken(sapToken: string): Promise<string> {
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
        
        this.browser = await chromium.launch({
          headless: !this.config.headful,
          args: ['--disable-dev-shm-usage', '--no-sandbox']
        });

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
      
      page.on('request', (request) => {
        const authHeader = request.headers()['authorization'];
        if (authHeader && request.url().includes('coveo.com')) {
          logger.debug(`📡 Coveo request: ${request.url().substring(0, 80)}`);
          logger.debug(`🔑 Auth header: ${authHeader.substring(0, 50)}...`);
          if (authHeader.startsWith('Bearer ')) {
            coveoToken = authHeader.replace('Bearer ', '');
            logger.debug(`🎯 CAPTURED Coveo token (length: ${coveoToken.length})`);
          }
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

      // Wait for any initialization
      await page.waitForTimeout(1000);
      
      // Now navigate to knowledge search page with a query to trigger Coveo API
      const searchParams = JSON.stringify({
        q: 'test',
        tab: 'Support',
        f: {
          documenttype: ['SAP Note']
        }
      });
      const searchPageUrl = `https://me.sap.com/knowledge/search/${encodeURIComponent(searchParams)}`;
      logger.debug(`🌐 Now navigating to knowledge search: ${searchPageUrl.substring(0, 100)}...`);

      try {
        response = await page.goto(searchPageUrl, {
          waitUntil: 'load',  // Wait for page load
          timeout: 30000  // Reduce timeout to 30s
        });
        logger.debug(`📊 Search page loaded: ${response?.status()} - ${page.url().substring(0, 100)}...`);
      } catch (searchGotoError) {
        logger.error(`❌ Search page navigation failed: ${searchGotoError instanceof Error ? searchGotoError.message : String(searchGotoError)}`);
        throw new Error(`Failed to load SAP search page: ${searchGotoError instanceof Error ? searchGotoError.message : 'Navigation timeout'}`);
      }

      // Wait for Coveo API call to complete
      await page.waitForTimeout(2000);
      logger.debug(`🔍 Coveo token captured from network: ${coveoToken ? 'YES' : 'NO'}`);

      // Try to extract token from page JavaScript context
      if (!coveoToken) {
        logger.debug('🔍 Attempting to extract Coveo token from page JavaScript');
        
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
      
      // Launch browser
      browser = await chromium.launch({
        headless: !this.config.headful,
        args: ['--disable-dev-shm-usage', '--no-sandbox']
      });

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