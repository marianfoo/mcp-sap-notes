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

export interface SapNoteReference {
  noteNumber: string;
  title: string;
  noteType?: string;
}

export interface SapNoteValidity {
  softwareComponent: string;
  versionFrom: string;
  versionTo: string;
}

export interface SapNoteSupportPackage {
  softwareComponent: string;
  name: string;
  level?: string;
}

export interface SapNoteCorrectionSummary {
  softwareComponent: string;
  pakId: string;
  count?: number;
}

export interface SapNoteDetail {
  id: string;
  title: string;
  summary: string;
  content: string;
  language: string;
  releaseDate: string;
  component?: string;
  componentText?: string;
  priority?: string;
  category?: string;
  version?: string;
  status?: string;
  url: string;
  // Enriched metadata from Detail API
  validity?: SapNoteValidity[];
  supportPackages?: SapNoteSupportPackage[];
  supportPackagePatches?: SapNoteSupportPackage[];
  references?: {
    referencedBy?: SapNoteReference[];
    referencesTo?: SapNoteReference[];
  };
  prerequisites?: SapNoteReference[];
  sideEffects?: {
    causing?: SapNoteReference[];
    solving?: SapNoteReference[];
  };
  correctionsSummary?: SapNoteCorrectionSummary[];
  manualActions?: string;
  correctionsInfo?: {
    totalCorrections?: number;
    totalManualActivities?: number;
    totalPrerequisites?: number;
  };
  attachments?: Array<{ filename: string; url?: string }>;
  downloadUrl?: string;
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

  // Coveo token cache (tokens are valid ~15-30 min)
  private coveoTokenCache: { token: string; expiresAt: number } | null = null;
  private readonly COVEO_TOKEN_TTL = 14 * 60 * 1000; // Cache for 14 minutes (conservative)

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

        // If Coveo returned 0 results and query looks like a note ID, try direct lookup
        if (results.length === 0 && /^\d{5,10}$/.test(query.trim())) {
          logger.info(`Query "${query}" looks like a note ID with 0 Coveo results, trying direct lookup...`);
          try {
            const note = await this.getNote(query.trim(), token);
            if (note) {
              logger.info(`Found note ${query} via direct lookup`);
              return {
                results: [{
                  id: note.id,
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
            }
          } catch (directError) {
            logger.warn(`Direct note lookup failed: ${directError instanceof Error ? directError.message : String(directError)}`);
          }
        }

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
        const helpfulMessage = `Search temporarily unavailable: Coveo search engine failed (${errorMessage}) and fallback search methods found no results.\n\n🔧 WORKAROUNDS:\n1. If you have a specific SAP Note ID (e.g., 2744792), use fetch(id="2744792") — this works perfectly!\n2. Try searching directly on https://me.sap.com/notes\n3. Search may work better outside containerized environments\n\nNote: Individual note retrieval via fetch() is fully functional and can access complete SAP Note content.`;
        
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
   * Fetch detailed correction instructions for a note via the CorrIns OData service.
   */
  async getCorrectionDetails(
    noteId: string,
    correctionsSummary: SapNoteCorrectionSummary[],
    token: string
  ): Promise<any[]> {
    logger.info(`🔧 Fetching correction details for note ${noteId} (${correctionsSummary.length} components)`);

    const allCorrections: any[] = [];
    const paddedNoteId = noteId.padStart(10, '0');

    for (const summary of correctionsSummary) {
      const pakId = summary.pakId;
      if (!pakId) {
        logger.debug(`Skipping correction for ${summary.softwareComponent} — no pakId`);
        continue;
      }

      try {
        const corrInsEntries = await this.fetchCorrInsSet(paddedNoteId, pakId, token);
        if (!corrInsEntries || corrInsEntries.length === 0) {
          logger.debug(`No correction entries found for PakId=${pakId}`);
          continue;
        }

        for (const entry of corrInsEntries) {
          const correction: any = {
            softwareComponent: entry.Name || summary.softwareComponent,
            versionFrom: entry.VerFrom || '',
            versionTo: entry.VerTo || '',
            sapNotesNumber: entry.SapNotesNumber || noteId,
            sapNotesTitle: entry.SapNotesTitle || '',
          };

          try {
            const tadirEntries = await this.fetchCorrInsNavigation(entry, 'TADIR', token);
            if (tadirEntries && tadirEntries.length > 0) {
              correction.objects = tadirEntries.map((t: any) => ({
                objectName: t.ObjName || '',
                objectType: t.ObjType || '',
              })).filter((o: any) => o.objectName);
            }
          } catch (tadirErr) {
            logger.debug(`TADIR fetch failed for correction ${entry.Aleid}: ${tadirErr}`);
          }

          try {
            const preEntries = await this.fetchCorrInsNavigation(entry, 'Prerequisite', token);
            if (preEntries && preEntries.length > 0) {
              correction.prerequisites = preEntries.map((p: any) => ({
                noteNumber: p.SapNotesNumber || '',
                title: p.Title || '',
              })).filter((p: any) => p.noteNumber);
            }
          } catch (preErr) {
            logger.debug(`Prerequisite fetch failed for correction ${entry.Aleid}: ${preErr}`);
          }

          allCorrections.push(correction);
        }
      } catch (compError) {
        logger.warn(`⚠️ Correction fetch failed for PakId=${pakId} (non-fatal): ${compError instanceof Error ? compError.message : String(compError)}`);
      }
    }

    logger.info(`🔧 Fetched ${allCorrections.length} correction entries for note ${noteId}`);
    return allCorrections;
  }

  private async fetchCorrInsSet(paddedNoteId: string, pakId: string, token: string): Promise<any[]> {
    const odataUrl = `https://me.sap.com/backend/raw/core/W7LegacyProxyVerticle/odata/svt/snogwscorrins/CorrInsSet?$filter=SapNotesNumber eq '${paddedNoteId}' and PakId eq '${pakId}'&$format=json`;

    const cookies = await this.formatCookiesForAPI(token);
    const response = await fetch(odataUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookies,
        'Referer': 'https://me.sap.com/',
        'Origin': 'https://me.sap.com',
      },
    });

    if (!response.ok) {
      throw new Error(`CorrInsSet HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    return json?.d?.results || [];
  }

  private async fetchCorrInsNavigation(entry: any, navProperty: string, token: string): Promise<any[]> {
    const keyParts = [
      `Aleid='${entry.Aleid}'`,
      `PakId='${entry.PakId}'`,
      `Insta='${entry.Insta}'`,
      `Vernr='${entry.Vernr}'`,
      `Name='${entry.Name}'`,
      `VerFrom='${entry.VerFrom}'`,
      `VerTo='${entry.VerTo}'`,
    ].join(',');

    const odataUrl = `https://me.sap.com/backend/raw/core/W7LegacyProxyVerticle/odata/svt/snogwscorrins/CorrInsSet(${keyParts})/${navProperty}?$format=json`;

    const cookies = await this.formatCookiesForAPI(token);
    const response = await fetch(odataUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookies,
        'Referer': 'https://me.sap.com/',
        'Origin': 'https://me.sap.com',
      },
    });

    if (!response.ok) {
      throw new Error(`${navProperty} HTTP ${response.status}: ${response.statusText}`);
    }

    const json = await response.json();
    if (json?.d?.results) return json.d.results;
    if (json?.d) return [json.d];
    return [];
  }

  private async formatCookiesForAPI(sapToken: string): Promise<string> {
    logger.debug(`🔍 ENHANCED DEBUG: Cookie formatting analysis:`);
    logger.debug(`   📊 Input token length: ${sapToken.length}`);
    logger.debug(`   🔧 Contains '=': ${sapToken.includes('=')}`);
    logger.debug(`   📄 First 50 chars: ${sapToken.substring(0, 50)}...`);
    
    if (sapToken.includes('=')) {
      const cookieCount = (sapToken.match(/=/g) || []).length;
      logger.debug(`   ✅ Using input token as-is (${cookieCount} cookies detected)`);
      return sapToken;
    }
    
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

  private async getCoveoTokenDirect(sapToken: string): Promise<string> {
    logger.info('🚀 Attempting direct Coveo token API approach');

    const meSapCookies = await this.getCookiesForDomain('me.sap.com');

    if (meSapCookies.length === 0) {
      const formattedCookies = await this.formatCookiesForAPI(sapToken);
      if (!formattedCookies || formattedCookies.length < 50) {
        throw new Error('No valid cookies available for direct API');
      }
    }

    const formattedCookies = meSapCookies.length > 0
      ? meSapCookies.map(c => `${c.name}=${c.value}`).join('; ')
      : await this.formatCookiesForAPI(sapToken);

    logger.debug(`Direct API: using ${meSapCookies.length} domain-filtered cookies`);

    const commonHeaders: Record<string, string> = {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://me.sap.com/',
      'Origin': 'https://me.sap.com',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      'Cookie': formattedCookies
    };

    const csrfCookie = meSapCookies.find(c => c.name.toLowerCase().includes('csrf') || c.name.toLowerCase().includes('xsrf'));
    if (csrfCookie) {
      commonHeaders['X-Csrf-Token'] = csrfCookie.value;
      commonHeaders['X-XSRF-TOKEN'] = csrfCookie.value;
      logger.debug(`Added CSRF token header from cookie: ${csrfCookie.name}`);
    }

    try {
      logger.debug('Step 1: Initializing Coveo application...');
      const appResponse = await fetch('https://me.sap.com/backend/raw/core/Applications/coveo', {
        method: 'GET',
        headers: commonHeaders,
        redirect: 'follow'
      });

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

  private async getCoveoToken(sapToken: string): Promise<string> {
    if (this.coveoTokenCache && Date.now() < this.coveoTokenCache.expiresAt) {
      logger.debug('Using cached Coveo token');
      return this.coveoTokenCache.token;
    }

    let token: string;

    try {
      token = await this.getCoveoTokenDirect(sapToken);
    } catch (directError) {
      const directErrorMsg = directError instanceof Error ? directError.message : String(directError);
      logger.warn(`Direct Coveo API failed: ${directErrorMsg}, falling back to Playwright...`);
      token = await this.getCoveoTokenWithPlaywright(sapToken);
    }

    this.coveoTokenCache = {
      token,
      expiresAt: Date.now() + this.COVEO_TOKEN_TTL
    };

    return token;
  }

  /**
   * Get Coveo bearer token using Playwright navigation (fallback method)
   */
  private async getCoveoTokenWithPlaywright(sapToken: string): Promise<string> {
    logger.debug('Fetching Coveo bearer token via Playwright');

    let page!: Page;

    try {
      // FIX: Siempre cerrar browser previo para evitar browserContext cerrado entre procesos de Claude Desktop
      if (this.browser) {
        logger.debug('Closing previous browser instance before creating fresh one');
        await this.browser.close().catch(() => {});
        this.browser = null;
        this.browserContext = null;
      }

      await this.ensurePersistentBrowser(sapToken);
      page = await this.browserContext!.newPage();

      let wasRedirectedToLogin = false;
      page.on('response', (response) => {
        const url = response.url();
        if (url.includes('authentication.') || url.includes('saml/login') || url.includes('accounts.sap.com/saml2/idp/sso')) {
          wasRedirectedToLogin = true;
          logger.warn(`⚠️ Detected redirect to authentication page: ${url.substring(0, 80)}...`);
        }
      });

      let coveoToken: string | null = null;
      
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
                }
              } catch (jsonError) {
                logger.debug(`   ❌ JSON parsing failed: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
              }
            } else {
              const errorText = await response.text();
              logger.debug(`   ❌ Error response body: ${errorText}`);
            }
          } catch (error) {
            logger.debug(`⚠️ Could not process CoveoToken response: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        
        if (response.url().includes('/backend/raw/') && response.url().includes('coveo')) {
          logger.debug(`🔍 Other Coveo-related call: ${response.status()} ${response.url()}`);
        }
      });

      logger.debug(`🌐 Navigating to SAP home page first...`);
      let response;
      
      try {
        response = await page.goto('https://me.sap.com/home', {
          waitUntil: 'load',
          timeout: 30000
        });
        logger.debug(`📊 Home page loaded: ${response?.status()} - ${page.url().substring(0, 100)}...`);
      } catch (gotoError) {
        logger.warn(`⚠️ Home page navigation timeout/error, trying direct search page: ${gotoError instanceof Error ? gotoError.message : String(gotoError)}`);
      }

      const currentUrl = page.url();
      if (wasRedirectedToLogin || currentUrl.includes('authentication.') || currentUrl.includes('saml/login')) {
        logger.error('❌ Session expired or cookies invalid - redirected to login page');
        logger.error('💡 Please run fresh authentication to update cached cookies');
        throw new Error('Session expired - authentication required. Run test:auth to refresh credentials.');
      }

      logger.debug(`🔍 ENHANCED DEBUG: Current page analysis:`);
      logger.debug(`   📄 Title: "${await page.title()}"`);
      logger.debug(`   🌐 URL: ${page.url()}`);
      logger.debug(`   🍪 Cookies count: ${(await page.context().cookies()).length}`);

      await page.waitForTimeout(2000);
      
      if (!coveoToken) {
        const searchParams = JSON.stringify({
          q: 'mm22',
          tab: 'All',
          f: { documenttype: ['SAP Note'] }
        });
        const searchPageUrl = `https://me.sap.com/knowledge/search/${encodeURIComponent(searchParams)}`;
        logger.debug(`🌐 Navigating to knowledge search to trigger CoveoToken: ${searchPageUrl.substring(0, 100)}...`);

        try {
          response = await page.goto(searchPageUrl, {
            waitUntil: 'networkidle',
            timeout: 45000
          });
          logger.debug(`📊 Search page loaded: ${response?.status()} - ${page.url().substring(0, 100)}...`);
        } catch (searchGotoError) {
          logger.warn(`⚠️ Search page navigation had issues: ${searchGotoError instanceof Error ? searchGotoError.message : String(searchGotoError)}`);
        }

        await page.waitForTimeout(5000);
      }
      
      logger.debug(`🔍 Final token capture status: ${coveoToken ? 'YES' : 'NO'}`);

      if (!coveoToken) {
        logger.debug('🔧 Attempting hybrid approach: direct API calls from browser context');
        
        try {
          const browserToken = await page.evaluate(async () => {
            try {
              const appResponse = await fetch('/backend/raw/core/Applications/coveo', {
                method: 'GET',
                headers: {
                  'Accept': 'application/json, text/javascript, */*; q=0.01',
                  'X-Requested-With': 'XMLHttpRequest'
                },
                credentials: 'include'
              });
              
              if (appResponse.ok) {
                await appResponse.json();
                
                const tokenResponse = await fetch('/backend/raw/coveo/CoveoToken', {
                  method: 'GET', 
                  headers: {
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With': 'XMLHttpRequest'
                  },
                  credentials: 'include'
                });
                
                if (tokenResponse.ok) {
                  const tokenData = await tokenResponse.json();
                  return tokenData.token || null;
                }
              }
              return null;
            } catch (error) {
              return null;
            }
          });
          
          if (browserToken) {
            coveoToken = browserToken;
            logger.debug(`🎯 CAPTURED Coveo token via browser context API (length: ${browserToken.length})`);
          }
        } catch (error) {
          logger.debug(`⚠️ Browser context API approach failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!coveoToken) {
        logger.debug('🔍 Final fallback: Attempting to extract Coveo token from page JavaScript');
        
        const tokenData = await page.evaluate(() => {
          const win = window as any;
          const findings: any = {
            token: null,
            foundIn: null,
            windowKeys: Object.keys(win).filter(k => k.toLowerCase().includes('cove')).slice(0, 5)
          };
          
          if (win.coveoToken) { findings.token = win.coveoToken; findings.foundIn = 'window.coveoToken'; return findings; }
          if (win.Coveo?.SearchEndpoint?.options?.accessToken) { findings.token = win.Coveo.SearchEndpoint.options.accessToken; findings.foundIn = 'window.Coveo'; return findings; }
          if (win.__COVEO_TOKEN__) { findings.token = win.__COVEO_TOKEN__; findings.foundIn = 'window.__COVEO_TOKEN__'; return findings; }
          
          try {
            const token = localStorage.getItem('coveo_token') || localStorage.getItem('coveoToken');
            if (token) { findings.token = token; findings.foundIn = 'localStorage'; return findings; }
          } catch (e) {}
          
          try {
            const token = sessionStorage.getItem('coveo_token') || sessionStorage.getItem('coveoToken');
            if (token) { findings.token = token; findings.foundIn = 'sessionStorage'; return findings; }
          } catch (e) {}
          
          return findings;
        });

        if (tokenData.token) {
          coveoToken = tokenData.token;
          logger.debug(`✅ Found Coveo token in: ${tokenData.foundIn}`);
        }
      }

      if (coveoToken) {
        logger.debug(`✅ Successfully extracted Coveo token (length: ${coveoToken.length})`);
        return coveoToken;
      }

      throw new Error('Unable to extract Coveo token from SAP search page');
      
    } catch (error) {
      logger.error('❌ Failed to get Coveo token:', error);
      
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
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }
  
  async cleanup(): Promise<void> {
    if (this.browser) {
      logger.debug('🧹 Closing persistent browser session');
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.browserContext = null;
    }
  }

  private async searchViaInternalAPI(query: string, token: string, maxResults: number): Promise<SapNoteResult[]> {
    logger.info(`🔍 Internal API: Searching for "${query}" with multiple endpoint strategies`);
    
    const searchEndpoints = [
      `/knowledge/search/${encodeURIComponent(JSON.stringify({
        q: query,
        tab: 'Support',
        f: [{ field: 'documenttype', value: ['SAP Note'] }]
      }))}`,
      `/support/search?q=${encodeURIComponent(query)}&type=note&format=json`,
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

  private async parseInternalSearchResponse(response: Response, query: string): Promise<SapNoteResult[]> {
    try {
      const contentType = response.headers.get('content-type') || '';
      logger.debug(`📄 Parsing response with content-type: ${contentType}`);
      
      if (contentType.includes('application/json')) {
        const data = await response.json();
        logger.debug(`📊 JSON response keys: ${Object.keys(data).join(', ')}`);
        
        if (data.Response && data.Response.SearchResults) {
          const results = data.Response.SearchResults.results || data.Response.SearchResults;
          if (Array.isArray(results)) {
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
        
        if (data.results && Array.isArray(data.results)) {
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
        
        if (Array.isArray(data)) {
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
      } else if (contentType.includes('text/html')) {
        const html = await response.text();
        return this.parseHTMLSearchResults(html, query);
      }
      
      return [];
    } catch (error) {
      logger.warn(`❌ Failed to parse internal API response: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private parseHTMLSearchResults(html: string, query: string): SapNoteResult[] {
    const results: SapNoteResult[] = [];
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

  private parseCoveoResponse(data: any): SapNoteResult[] {
    const results: SapNoteResult[] = [];

    if (!data.results || !Array.isArray(data.results)) {
      logger.warn('⚠️ No results array in Coveo response');
      return results;
    }

    logger.debug(`📄 Parsing ${data.results.length} Coveo results...`);

    for (const item of data.results) {
      try {
        const noteId = item.raw?.mh_id || 
                      item.raw?.permanentid?.match(/\d{6,8}/)?.[0] || 
                      item.title?.match(/\d{6,8}/)?.[0] ||
                      'unknown';

        const languageArray = item.raw?.language || item.raw?.syslanguage || [];
        const language = Array.isArray(languageArray) ? languageArray[0] : (languageArray || 'EN');
        
        const componentArray = item.raw?.mh_app_component || item.raw?.mh_all_hierarchical_component || [];
        const component = Array.isArray(componentArray) ? componentArray[0] : componentArray;

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
      redirect: 'follow'
    });

    logger.debug(`📊 Response: ${response.status} ${response.statusText}`);

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
    }

    return response;
  }

  private async parseNoteResponse(response: Response, noteId: string): Promise<SapNoteDetail | null> {
    const responseText = await response.text();
    
    try {
      const jsonData = JSON.parse(responseText);
      if (jsonData.d) {
        return this.mapToSapNoteDetail(jsonData.d, noteId);
      }
    } catch (jsonError) {
      logger.debug('Note response is not JSON, attempting HTML parsing');
    }

    return this.parseHtmlForNoteDetail(responseText, noteId);
  }

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

  private parseHtmlForNoteDetail(html: string, noteId: string): SapNoteDetail | null {
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

  private async makeRawRequest(endpoint: string, token: string): Promise<Response> {
    const url = `${this.rawNotesUrl}${endpoint}`;
    logger.debug(`🌐 Making raw request to: ${url}`);

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
      redirect: 'follow'
    });

    logger.debug(`📊 Raw response: ${response.status} ${response.statusText} (${response.url})`);

    if (!response.ok && response.status !== 404 && response.status !== 302 && response.status !== 301) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
    }

    return response;
  }

  private async parseRawNoteDetail(response: Response, noteId: string): Promise<SapNoteDetail | null> {
    const responseText = await response.text();
    
    try {
      const jsonData = JSON.parse(responseText);
      
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

    if (responseText.includes('fragmentAfterLogin') || responseText.includes('document.cookie')) {
      logger.debug('Detected redirect page, note likely exists but requires browser navigation');
      
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

    return this.parseHtmlForNoteDetail(responseText, noteId);
  }

  private extractEnrichedMetadata(sapNote: any, detail: SapNoteDetail): void {
    try {
      const validityItems = sapNote.Validity?.Items;
      if (Array.isArray(validityItems) && validityItems.length > 0) {
        detail.validity = validityItems.map((item: any) => ({
          softwareComponent: item.Name?.value || item.SoftwareComponentID?.value || '',
          versionFrom: item.VersionFrom?.value || '',
          versionTo: item.VersionTo?.value || ''
        })).filter((v: SapNoteValidity) => v.softwareComponent);
      }
    } catch (e) { logger.debug(`Validity extraction skipped: ${e}`); }

    try {
      const spItems = sapNote.SupportPackage?.Items;
      if (Array.isArray(spItems) && spItems.length > 0) {
        detail.supportPackages = spItems.map((item: any) => ({
          softwareComponent: item.Name?.value || item.SoftwareComponentID?.value || '',
          name: item.SupportPackageName?.value || item.SPName?.value || '',
          level: item.Level?.value
        })).filter((sp: SapNoteSupportPackage) => sp.softwareComponent);
      }
    } catch (e) { logger.debug(`SupportPackage extraction skipped: ${e}`); }

    try {
      const sppItems = sapNote.SupportPackagePatch?.Items;
      if (Array.isArray(sppItems) && sppItems.length > 0) {
        detail.supportPackagePatches = sppItems.map((item: any) => ({
          softwareComponent: item.Name?.value || item.SoftwareComponentID?.value || '',
          name: item.SupportPackagePatchName?.value || item.SPPName?.value || '',
          level: item.Level?.value
        })).filter((sp: SapNoteSupportPackage) => sp.softwareComponent);
      }
    } catch (e) { logger.debug(`SupportPackagePatch extraction skipped: ${e}`); }

    try {
      const refs: SapNoteDetail['references'] = {};
      const refTo = sapNote.References?.RefTo?.Items;
      if (Array.isArray(refTo) && refTo.length > 0) {
        refs.referencesTo = refTo.map((item: any) => ({
          noteNumber: item.SAPNoteNumber?.value || item.Number?.value || '',
          title: item.Title?.value || '',
          noteType: item.Type?.value
        })).filter((r: SapNoteReference) => r.noteNumber);
      }
      const refBy = sapNote.References?.RefBy?.Items;
      if (Array.isArray(refBy) && refBy.length > 0) {
        refs.referencedBy = refBy.map((item: any) => ({
          noteNumber: item.SAPNoteNumber?.value || item.Number?.value || '',
          title: item.Title?.value || '',
          noteType: item.Type?.value
        })).filter((r: SapNoteReference) => r.noteNumber);
      }
      if (refs.referencesTo || refs.referencedBy) {
        detail.references = refs;
      }
    } catch (e) { logger.debug(`References extraction skipped: ${e}`); }

    try {
      const preItems = sapNote.Preconditions?.Items;
      if (Array.isArray(preItems) && preItems.length > 0) {
        detail.prerequisites = preItems.map((item: any) => ({
          noteNumber: item.SAPNoteNumber?.value || item.Number?.value || '',
          title: item.Title?.value || ''
        })).filter((p: SapNoteReference) => p.noteNumber);
      }
    } catch (e) { logger.debug(`Prerequisites extraction skipped: ${e}`); }

    try {
      const sideEffects: SapNoteDetail['sideEffects'] = {};
      const causing = sapNote.SideEffects?.SideEffectsCausing?.Items;
      if (Array.isArray(causing) && causing.length > 0) {
        sideEffects.causing = causing.map((item: any) => ({
          noteNumber: item.SAPNoteNumber?.value || item.Number?.value || '',
          title: item.Title?.value || ''
        })).filter((s: SapNoteReference) => s.noteNumber);
      }
      const solving = sapNote.SideEffects?.SideEffectsSolving?.Items;
      if (Array.isArray(solving) && solving.length > 0) {
        sideEffects.solving = solving.map((item: any) => ({
          noteNumber: item.SAPNoteNumber?.value || item.Number?.value || '',
          title: item.Title?.value || ''
        })).filter((s: SapNoteReference) => s.noteNumber);
      }
      if (sideEffects.causing || sideEffects.solving) {
        detail.sideEffects = sideEffects;
      }
    } catch (e) { logger.debug(`SideEffects extraction skipped: ${e}`); }

    try {
      const corrItems = sapNote.CorrectionInstructions?.Items;
      if (Array.isArray(corrItems) && corrItems.length > 0) {
        detail.correctionsSummary = corrItems.map((item: any) => ({
          softwareComponent: item.Name?.value || item.SoftwareComponentName?.value || '',
          pakId: item.URL?.value?.match(/corrins\/\d+\/(\d+)/)?.[1] || item.PakId?.value || '',
          count: item.Count?.value ? parseInt(item.Count.value, 10) : undefined
        })).filter((c: SapNoteCorrectionSummary) => c.softwareComponent);
      }
    } catch (e) { logger.debug(`CorrectionInstructions summary extraction skipped: ${e}`); }

    try {
      const manualActions = sapNote.ManualActions?.value;
      if (manualActions && typeof manualActions === 'string' && manualActions.trim()) {
        detail.manualActions = manualActions;
      }
    } catch (e) { logger.debug(`ManualActions extraction skipped: ${e}`); }

    try {
      const corrInfo = sapNote.CorrectionsInfo;
      if (corrInfo) {
        detail.correctionsInfo = {
          totalCorrections: corrInfo.TotalCorrections?.value ? parseInt(corrInfo.TotalCorrections.value, 10) : undefined,
          totalManualActivities: corrInfo.TotalManualActivities?.value ? parseInt(corrInfo.TotalManualActivities.value, 10) : undefined,
          totalPrerequisites: corrInfo.TotalPrerequisites?.value ? parseInt(corrInfo.TotalPrerequisites.value, 10) : undefined
        };
      }
    } catch (e) { logger.debug(`CorrectionsInfo extraction skipped: ${e}`); }

    try {
      const attachItems = sapNote.Attachments?.Items;
      if (Array.isArray(attachItems) && attachItems.length > 0) {
        detail.attachments = attachItems.map((item: any) => ({
          filename: item.Filename?.value || item.Name?.value || 'unknown',
          url: item.URL?.value
        }));
      }
    } catch (e) { logger.debug(`Attachments extraction skipped: ${e}`); }

    try {
      const downloadUrl = sapNote.Actions?.Download?.url;
      if (downloadUrl) {
        detail.downloadUrl = downloadUrl;
      }
    } catch (e) { logger.debug(`DownloadURL extraction skipped: ${e}`); }
  }

  /**
   * Ensure the persistent browser is available and has cookies loaded.
   */
  private async ensurePersistentBrowser(token: string): Promise<void> {
    const now = Date.now();

    if (this.browser && (now - this.browserLastUsed > this.BROWSER_IDLE_TIMEOUT)) {
      logger.debug('Closing idle persistent browser');
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.browserContext = null;
    }

    if (this.browser && this.browser.isConnected()) {
      this.browserLastUsed = Date.now();
      return;
    }

    const isDocker = process.env.DOCKER_ENV === 'true' ||
                    process.env.NODE_ENV === 'production' ||
                    !process.env.DISPLAY ||
                    !process.stdin.isTTY ||
                    process.env.CI === 'true';

    const forceHeadless = isDocker || process.platform === 'linux';
    const shouldUseHeadless = forceHeadless || !this.config.headful;

    this.browser = await chromium.launch({
      headless: shouldUseHeadless,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    });

    this.browserContext = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    });

    const cookies = await this.getCachedCookies();
    if (cookies.length > 0) {
      await this.browserContext.addCookies(cookies);
      logger.debug(`Added ${cookies.length} cached cookies to persistent browser`);
    } else {
      const parsedCookies = this.parseCookiesFromToken(token);
      if (parsedCookies.length > 0) {
        await this.browserContext.addCookies(parsedCookies);
      }
    }

    this.browserLastUsed = Date.now();
    logger.info('Persistent browser session created');
  }

  private async getNoteWithPlaywright(noteId: string, token: string): Promise<SapNoteDetail | null> {
    let page!: Page;

    try {
      // FIX: Siempre cerrar browser previo para evitar browserContext cerrado entre procesos de Claude Desktop
      if (this.browser) {
        logger.debug('Closing previous browser instance before creating fresh one');
        await this.browser.close().catch(() => {});
        this.browser = null;
        this.browserContext = null;
      }

      await this.ensurePersistentBrowser(token);
      page = await this.browserContext!.newPage();

      const rawUrl = `https://me.sap.com/backend/raw/sapnotes/Detail?q=${noteId}&t=E&isVTEnabled=false`;
      logger.debug(`🌐 Navigating to: ${rawUrl}`);

      const response = await page.goto(rawUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      if (!response || !response.ok()) {
        throw new Error(`HTTP ${response?.status()}: Failed to load page`);
      }

      await page.waitForTimeout(2000);

      const content = await page.content();
      const pageTitle = await page.title();
      const currentUrl = page.url();
      
      logger.debug(`📄 Page loaded - Title: "${pageTitle}", URL: ${currentUrl}`);
      logger.debug(`📄 Content length: ${content.length} characters`);
      
      const contentPreview = content.substring(0, 500);
      logger.debug(`📄 Content preview: ${contentPreview}`);
      
      try {
        const bodyText = await page.locator('body').textContent();
        if (bodyText) {
          logger.debug(`📊 Body text length: ${bodyText.length}`);
          
          const trimmedBodyText = bodyText.trim();
          if (trimmedBodyText.startsWith('{') && trimmedBodyText.endsWith('}')) {
            const jsonData = JSON.parse(trimmedBodyText);
            logger.info(`🎉 Successfully parsed JSON from page body!`);
            logger.debug(`📊 JSON keys: ${Object.keys(jsonData).join(', ')}`);
            
            if (jsonData.Response && jsonData.Response.SAPNote) {
              const sapNote = jsonData.Response.SAPNote;
              const header = sapNote.Header || {};

              logger.info(`📄 Extracting SAP Note data from API response`);

              const detail: SapNoteDetail = {
                id: header.Number?.value || noteId,
                title: sapNote.Title?.value || `SAP Note ${noteId}`,
                summary: header.Type?.value || 'SAP Knowledge Base Article',
                content: sapNote.LongText?.value || 'No content available',
                language: header.Language?.value || 'EN',
                releaseDate: header.ReleasedOn?.value || 'Unknown',
                component: header.SAPComponentKey?.value,
                componentText: header.SAPComponentKeyText?.value,
                priority: header.Priority?.value,
                category: header.Category?.value,
                version: header.Version?.value != null ? String(header.Version.value) : undefined,
                status: header.Status?.value,
                url: `https://launchpad.support.sap.com/#/notes/${noteId}`
              };

              try {
                this.extractEnrichedMetadata(sapNote, detail);
              } catch (enrichError) {
                logger.warn(`⚠️ Enriched metadata extraction failed (non-fatal): ${enrichError instanceof Error ? enrichError.message : String(enrichError)}`);
              }

              return detail;
            }

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

      try {
        const jsonMatch = content.match(/<body[^>]*>(.*?)<\/body>/s);
        if (jsonMatch && jsonMatch[1]) {
          const bodyContent = jsonMatch[1].trim();
          if (bodyContent.startsWith('{') && bodyContent.endsWith('}')) {
            const jsonData = JSON.parse(bodyContent);
            logger.info(`🎉 Found JSON in HTML body!`);

            if (jsonData.Response && jsonData.Response.SAPNote) {
              const sapNote = jsonData.Response.SAPNote;
              const header = sapNote.Header || {};

              const detail: SapNoteDetail = {
                id: header.Number?.value || noteId,
                title: sapNote.Title?.value || `SAP Note ${noteId}`,
                summary: header.Type?.value || 'SAP Knowledge Base Article',
                content: sapNote.LongText?.value || 'No content available',
                language: header.Language?.value || 'EN',
                releaseDate: header.ReleasedOn?.value || 'Unknown',
                component: header.SAPComponentKey?.value,
                componentText: header.SAPComponentKeyText?.value,
                priority: header.Priority?.value,
                category: header.Category?.value,
                version: header.Version?.value != null ? String(header.Version.value) : undefined,
                status: header.Status?.value,
                url: `https://launchpad.support.sap.com/#/notes/${noteId}`
              };

              try {
                this.extractEnrichedMetadata(sapNote, detail);
              } catch (enrichError) {
                logger.warn(`⚠️ Enriched metadata extraction failed (non-fatal): ${enrichError instanceof Error ? enrichError.message : String(enrichError)}`);
              }

              return detail;
            }

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

      logger.debug(`📄 Parsing HTML content (${content.length} characters)`);
      
      const noteData = await page.evaluate((noteId) => {
        const result = { id: noteId, title: '', summary: '', content: '', found: false };

        const titleElement = document.querySelector('h1, h2, .note-title, .title');
        if (titleElement) { result.title = titleElement.textContent?.trim() || ''; result.found = true; }

        const contentElement = document.querySelector('.note-content, .content, .description, .text');
        if (contentElement) { result.content = contentElement.textContent?.trim() || ''; result.found = true; }

        const summaryElement = document.querySelector('.summary, .abstract, .description');
        if (summaryElement) { result.summary = summaryElement.textContent?.trim() || ''; result.found = true; }

        if (result.title || result.content || result.summary) { result.found = true; }

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

      logger.warn(`⚠️ Playwright loaded page but couldn't extract note content`);
      return null;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Playwright note extraction failed: ${errorMessage}`);
      throw new Error(`Playwright extraction failed: ${errorMessage}`);
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
    }
  }

  private parseCookiesFromToken(token: string): Array<{name: string, value: string, domain: string, path: string}> {
    const cookies: Array<{name: string, value: string, domain: string, path: string}> = [];
    
    try {
      const cookiePairs = token.split(';');
      
      for (const pair of cookiePairs) {
        const trimmed = pair.trim();
        if (trimmed && trimmed.includes('=')) {
          const equalIndex = trimmed.indexOf('=');
          const name = trimmed.substring(0, equalIndex).trim();
          let value = trimmed.substring(equalIndex + 1).trim();
          
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          
          if (name && value && name.length > 0 && value.length > 0) {
            if (!['path', 'domain', 'secure', 'httponly', 'samesite', 'max-age', 'expires'].includes(name.toLowerCase())) {
              cookies.push({ name, value, domain: '.sap.com', path: '/' });
            }
          }
        }
      }
      
      logger.debug(`🍪 Parsed ${cookies.length} cookies from token`);
      
      if (cookies.length > 0) {
        const cookieNames = cookies.slice(0, 5).map(c => c.name).join(', ');
        logger.debug(`🍪 Cookie names: ${cookieNames}${cookies.length > 5 ? '...' : ''}`);
      }
      
    } catch (error) {
      logger.warn(`⚠️ Failed to parse cookies from token: ${error}`);
    }
    
    return cookies;
  }

  private async getCookiesForDomain(targetDomain: string): Promise<Array<{name: string, value: string, domain: string, path: string}>> {
    const allCookies = await this.getCachedCookies();
    return allCookies.filter(c => {
      const cookieDomain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
      const target = `.${targetDomain}`;
      return target.endsWith(cookieDomain) || cookieDomain === target;
    });
  }

  private async getCachedCookies(): Promise<Array<{name: string, value: string, domain: string, path: string, expires?: number, secure?: boolean, httpOnly?: boolean, sameSite?: 'Strict' | 'Lax' | 'None'}>> {
    try {
      const { readFileSync, existsSync } = await import('fs');
      const { join } = await import('path');
      
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