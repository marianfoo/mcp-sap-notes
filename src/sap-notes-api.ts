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
 * SAP Notes API Client - Direct access to SAP Launchpad APIs
 * Replaces Coveo with native SAP Note search
 */
export class SapNotesApiClient {
  private config: ServerConfig;
  private baseUrl = 'https://launchpad.support.sap.com';
  private rawNotesUrl = 'https://me.sap.com/backend/raw/sapnotes';

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /**
   * Search for SAP Notes using the SAP OData API
   */
  async searchNotes(query: string, token: string, maxResults: number = 10): Promise<SapNoteSearchResponse> {
    logger.info(`🔍 Searching SAP Notes for: "${query}"`);

    try {
      // Try different search approaches
      const searchMethods = [
        () => this.searchByNoteNumber(query, token),
        () => this.searchByKeyword(query, token, maxResults),
        () => this.searchGeneral(query, token, maxResults)
      ];

      for (const searchMethod of searchMethods) {
        try {
          const result = await searchMethod();
          if (result.results.length > 0) {
            logger.info(`✅ Found ${result.results.length} results using ${searchMethod.name}`);
            return result;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(`⚠️ Search method ${searchMethod.name} failed: ${errorMessage}`);
        }
      }

      // If no results found, return empty response
      return {
        results: [],
        totalResults: 0,
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
   * Search by specific note number (e.g., "2744792")
   */
  private async searchByNoteNumber(query: string, token: string): Promise<SapNoteSearchResponse> {
    // Check if query looks like a note number
    const noteNumberMatch = query.match(/\b(\d{6,8})\b/);
    if (!noteNumberMatch) {
      throw new Error('Not a note number');
    }

    const noteNumber = noteNumberMatch[1];
    
    // Try the raw notes API first (better endpoint)
    try {
      const rawResponse = await this.makeRawRequest(`/Detail?q=${noteNumber}&t=E&isVTEnabled=false`, token);
      if (rawResponse.ok) {
        const result = await this.parseRawNoteResponse(rawResponse, noteNumber, query);
        if (result.results.length > 0) {
          return result;
        }
      }
    } catch (error) {
      logger.debug('Raw notes API search failed, trying OData fallback');
    }
    
    // Fallback to OData endpoint
    const endpoint = `/services/odata/svt/snogwscorr/KnowledgeBaseEntries?$filter=SapNote eq '${noteNumber}'&$format=json`;
    const response = await this.makeRequest(endpoint, token);
    return this.parseSearchResponse(response, query);
  }

  /**
   * Search by keyword in title/content
   */
  private async searchByKeyword(query: string, token: string, maxResults: number): Promise<SapNoteSearchResponse> {
    const encodedQuery = encodeURIComponent(query);
    const endpoint = `/services/odata/svt/snogwscorr/KnowledgeBaseEntries?$filter=substringof('${encodedQuery}',Title) or substringof('${encodedQuery}',Summary)&$top=${maxResults}&$format=json`;
    
    const response = await this.makeRequest(endpoint, token);
    return this.parseSearchResponse(response, query);
  }

  /**
   * General search across multiple fields
   */
  private async searchGeneral(query: string, token: string, maxResults: number): Promise<SapNoteSearchResponse> {
    const encodedQuery = encodeURIComponent(query);
    const endpoint = `/services/odata/svt/snogwscorr/KnowledgeBaseEntries?$filter=substringof('${encodedQuery}',SapNote) or substringof('${encodedQuery}',Title)&$top=${maxResults}&$format=json`;
    
    const response = await this.makeRequest(endpoint, token);
    return this.parseSearchResponse(response, query);
  }

  /**
   * Make HTTP request to SAP API
   */
  private async makeRequest(endpoint: string, token: string): Promise<Response> {
    const url = `${this.baseUrl}${endpoint}`;
    
    logger.debug(`🌐 Making request to: ${url}`);

    const headers: Record<string, string> = {
      'Cookie': token,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
   * Parse search response from SAP OData API
   */
  private async parseSearchResponse(response: Response, query: string): Promise<SapNoteSearchResponse> {
    const responseText = await response.text();
    
    // Try to parse as JSON first
    try {
      const jsonData = JSON.parse(responseText);
      
      if (jsonData.d && jsonData.d.results) {
        // OData format
        const results = jsonData.d.results.map((item: any) => this.mapToSapNoteResult(item));
        return {
          results,
          totalResults: results.length,
          query
        };
      }
      
      if (jsonData.results) {
        // Direct results format
        const results = jsonData.results.map((item: any) => this.mapToSapNoteResult(item));
        return {
          results,
          totalResults: results.length,
          query
        };
      }
    } catch (jsonError) {
      // Not JSON, try to parse HTML
      logger.debug('Response is not JSON, attempting HTML parsing');
    }

    // If we get HTML, try to extract note information
    const htmlResults = this.parseHtmlForNotes(responseText, query);
    
    return {
      results: htmlResults,
      totalResults: htmlResults.length,
      query
    };
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
   * Map OData result to our SapNoteResult format
   */
  private mapToSapNoteResult(item: any): SapNoteResult {
    return {
      id: item.SapNote || item.Id || item.id || 'unknown',
      title: item.Title || item.title || 'Unknown Title',
      summary: item.Summary || item.summary || item.Description || 'No summary available',
      language: item.Language || item.language || 'EN',
      releaseDate: item.ReleaseDate || item.releaseDate || item.CreationDate || 'Unknown',
      component: item.Component || item.component,
      url: `https://launchpad.support.sap.com/#/notes/${item.SapNote || item.Id || item.id}`
    };
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
   * Parse HTML response to extract SAP Note information
   */
  private parseHtmlForNotes(html: string, query: string): SapNoteResult[] {
    const results: SapNoteResult[] = [];
    
    // Look for note numbers in HTML
    const notePattern = /\b(\d{6,8})\b/g;
    const matches = html.match(notePattern);
    
    if (matches) {
      const uniqueNotes = [...new Set(matches)];
      for (const noteId of uniqueNotes.slice(0, 5)) { // Limit to 5 results
        results.push({
          id: noteId,
          title: `SAP Note ${noteId}`,
          summary: `Found via search for: ${query}`,
          language: 'EN',
          releaseDate: 'Unknown',
          url: `https://launchpad.support.sap.com/#/notes/${noteId}`
        });
      }
    }
    
    return results;
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
    const headers: Record<string, string> = {
      'Cookie': token,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
   * Parse raw note response for search results
   */
  private async parseRawNoteResponse(response: Response, noteId: string, query: string): Promise<SapNoteSearchResponse> {
    const responseText = await response.text();
    
    try {
      const jsonData = JSON.parse(responseText);
      
      // Check if we have a valid note response
      if (jsonData && (jsonData.SapNote || jsonData.id || jsonData.noteId)) {
        const noteResult: SapNoteResult = {
          id: jsonData.SapNote || jsonData.id || jsonData.noteId || noteId,
          title: jsonData.Title || jsonData.title || jsonData.ShortText || `SAP Note ${noteId}`,
          summary: jsonData.Summary || jsonData.summary || jsonData.Abstract || jsonData.abstract || 'SAP Note details',
          language: jsonData.Language || jsonData.language || 'EN',
          releaseDate: jsonData.ReleaseDate || jsonData.releaseDate || jsonData.CreationDate || 'Unknown',
          component: jsonData.Component || jsonData.component,
          url: `https://launchpad.support.sap.com/#/notes/${noteId}`
        };

        return {
          results: [noteResult],
          totalResults: 1,
          query
        };
      }
    } catch (jsonError) {
      logger.debug('Raw response is not JSON, checking for HTML redirect/content');
    }

    // Check if this is a redirect page that might lead to note content
    if (responseText.includes('fragmentAfterLogin') || responseText.includes('document.cookie')) {
      logger.debug('Detected redirect page, creating result based on requested note');
      
      // If we successfully got a response for a specific note ID, assume it exists
      if (noteId && noteId.match(/^\d{6,8}$/)) {
        const noteResult: SapNoteResult = {
          id: noteId,
          title: `SAP Note ${noteId}`,
          summary: 'Note found via raw API (content requires additional navigation)',
          language: 'EN',
          releaseDate: 'Unknown',
          url: `https://launchpad.support.sap.com/#/notes/${noteId}`
        };

        return {
          results: [noteResult],
          totalResults: 1,
          query
        };
      }
    }

    // Fallback to HTML parsing
    const htmlResults = this.parseHtmlForNotes(responseText, query);
    return {
      results: htmlResults,
      totalResults: htmlResults.length,
      query
    };
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
  private async getCachedCookies(): Promise<Array<{name: string, value: string, domain: string, path: string}>> {
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