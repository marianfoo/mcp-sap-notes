import { logger } from './logger.js';

/**
 * Direct Coveo Token API - Standalone utility for getting Coveo tokens
 * Based on network analysis of SAP knowledge search flow
 */
export class CoveoTokenDirect {
  
  /**
   * Get Coveo bearer token using direct API calls
   * This method replicates the exact network flow seen in browser dev tools
   * 
   * @param sapToken - SAP authentication token (cookies)
   * @param language - Language preference (defaults to 'de')
   * @returns Promise<string> - Coveo bearer token
   */
  static async getToken(sapToken: string, language: string = 'de'): Promise<string> {
    logger.info('🚀 CoveoTokenDirect: Starting direct API token retrieval');
    
    // Construct knowledge search URL to use as referrer (required for proper context)
    const searchParams = JSON.stringify({
      q: 'test',
      tab: 'All',
      f: { documenttype: ['SAP Note'] }
    });
    const referrerUrl = `https://me.sap.com/knowledge/search/${encodeURIComponent(searchParams)}`;
    
    // Headers based on actual network requests captured in browser
    const commonHeaders = {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': language,
      'X-Requested-With': 'XMLHttpRequest',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Priority': 'u=1, i',
      'Referer': referrerUrl,
      'Sec-Ch-Ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors', 
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Cookie': sapToken
    };

    try {
      // Step 1: Initialize Coveo application (prerequisite call)
      logger.debug('📋 CoveoTokenDirect: Initializing Coveo application...');
      const appResponse = await fetch('https://me.sap.com/backend/raw/core/Applications/coveo', {
        method: 'GET',
        headers: commonHeaders
      });

      if (!appResponse.ok) {
        throw new Error(`Coveo app initialization failed: ${appResponse.status} ${appResponse.statusText}`);
      }

      const appData = await appResponse.json();
      logger.debug(`✅ CoveoTokenDirect: App initialized - component: ${appData.component}`);

      // Brief delay to mimic browser timing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Step 2: Get Coveo token (main call)
      logger.debug('🔑 CoveoTokenDirect: Fetching Coveo token...');
      const tokenResponse = await fetch('https://me.sap.com/backend/raw/coveo/CoveoToken', {
        method: 'GET',
        headers: commonHeaders
      });

      if (!tokenResponse.ok) {
        throw new Error(`Coveo token request failed: ${tokenResponse.status} ${tokenResponse.statusText}`);
      }

      const tokenData = await tokenResponse.json();
      
      if (!tokenData.token) {
        throw new Error('Token not found in API response');
      }

      // Validate token format (should be JWT)
      if (!tokenData.token.startsWith('eyJ')) {
        logger.warn(`⚠️ CoveoTokenDirect: Token doesn't appear to be JWT format: ${tokenData.token.substring(0, 20)}...`);
      }

      logger.info(`✅ CoveoTokenDirect: SUCCESS - Token retrieved (length: ${tokenData.token.length}, org: ${tokenData.organizationId || 'unknown'})`);
      return tokenData.token;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`❌ CoveoTokenDirect: Failed - ${errorMsg}`);
      
      // Provide specific error context for common issues
      if (errorMsg.includes('401') || errorMsg.includes('403')) {
        throw new Error(`Authentication failed: ${errorMsg}. Check if SAP session is still valid.`);
      } else if (errorMsg.includes('404')) {
        throw new Error(`Coveo API endpoint not found: ${errorMsg}. SAP may have changed their API structure.`);
      } else if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('network')) {
        throw new Error(`Network error: ${errorMsg}. Check internet connection and SAP server accessibility.`);
      }
      
      throw new Error(`CoveoTokenDirect failed: ${errorMsg}`);
    }
  }

  /**
   * Test the Coveo token retrieval with enhanced error reporting
   * Useful for debugging and verification
   */
  static async testConnection(sapToken: string): Promise<{
    success: boolean;
    token?: string;
    error?: string;
    timing: {
      appInit: number;
      tokenFetch: number;
      total: number;
    };
  }> {
    const startTime = Date.now();
    let appInitTime = 0;
    let tokenFetchTime = 0;

    try {
      const appStartTime = Date.now();
      // Test app initialization
      await fetch('https://me.sap.com/backend/raw/core/Applications/coveo', {
        method: 'GET',
        headers: {
          'Cookie': sapToken,
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      appInitTime = Date.now() - appStartTime;

      const tokenStartTime = Date.now();
      // Test token retrieval
      const token = await this.getToken(sapToken);
      tokenFetchTime = Date.now() - tokenStartTime;

      return {
        success: true,
        token,
        timing: {
          appInit: appInitTime,
          tokenFetch: tokenFetchTime,
          total: Date.now() - startTime
        }
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timing: {
          appInit: appInitTime,
          tokenFetch: tokenFetchTime, 
          total: Date.now() - startTime
        }
      };
    }
  }
}

export default CoveoTokenDirect;