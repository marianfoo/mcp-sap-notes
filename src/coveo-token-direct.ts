/**
 * Direct Coveo Token Extraction (No Playwright)
 * 
 * This module extracts the Coveo bearer token by making direct HTTP requests
 * to SAP's search API endpoint, avoiding Playwright navigation issues on servers.
 */

import { logger } from './logger.js';

interface CoveoTokenResponse {
  token: string;
  expiresAt?: number;
}

/**
 * Get Coveo token by making a direct API call to SAP's search endpoint
 * This triggers the Coveo API and we can extract the token from the response
 */
export async function getCoveoTokenDirect(sapCookies: string): Promise<string> {
  logger.debug('🔑 Fetching Coveo token via direct API call (no browser)');
  
  const timeout = 15000; // 15 second timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // Method 1: Try to get token from SAP's search initialization endpoint
    logger.debug('📡 Attempting to fetch token from SAP search API...');
    
    const searchInitUrl = 'https://me.sap.com/api/search/token';
    
    const response = await fetch(searchInitUrl, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'cookie': sapCookies,
        'referer': 'https://me.sap.com/knowledge/search',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data = await response.json();
      if (data.token) {
        logger.debug(`✅ Got Coveo token from API (length: ${data.token.length})`);
        return data.token;
      }
    }
    
    // Method 2: Fallback - make a simple search request and capture the token from error/response
    logger.debug('🔄 Trying fallback method: direct Coveo search...');
    return await getCoveoTokenFromDirectSearch(sapCookies);
    
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      logger.error(`❌ Token fetch timeout after ${timeout}ms`);
      throw new Error(`Coveo token fetch timed out after ${timeout}ms`);
    }
    
    logger.warn(`⚠️  Direct token fetch failed: ${error.message}`);
    logger.debug('🔄 Trying fallback method...');
    
    // Try fallback method
    return await getCoveoTokenFromDirectSearch(sapCookies);
  }
}

/**
 * Fallback: Get token by making a Coveo search request
 * The Coveo API endpoint itself might return the token in headers or error response
 */
async function getCoveoTokenFromDirectSearch(sapCookies: string): Promise<string> {
  logger.debug('🔍 Making direct Coveo search to extract token...');
  
  const timeout = 15000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // Use a hardcoded token format that's commonly used by Coveo for SAP
    // This is a temporary token that gets us access to make the initial request
    const initialToken = 'xx564cb4c-18f2-4186-9128-e2e4a42d9f5e'; // Placeholder for initial attempt
    
    const coveoUrl = 'https://sapamericaproductiontyfzmfz0.org.coveo.com/rest/search/v2/token';
    
    const response = await fetch(coveoUrl, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'cookie': sapCookies,
        'referer': 'https://me.sap.com/',
        'origin': 'https://me.sap.com'
      },
      body: JSON.stringify({
        organizationId: 'sapamericaproductiontyfzmfz0'
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // Check if response headers contain the token
    const authHeader = response.headers.get('x-coveo-auth-token') || response.headers.get('authorization');
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      logger.debug(`✅ Extracted token from response headers (length: ${token.length})`);
      return token;
    }
    
    // If response is OK, try to parse token from body
    if (response.ok) {
      const data = await response.json();
      if (data.token) {
        logger.debug(`✅ Got token from response body (length: ${data.token.length})`);
        return data.token;
      }
    }
    
    logger.error('❌ Could not extract Coveo token from any source');
    throw new Error('Failed to obtain Coveo token - session may have expired. Run test:auth to refresh credentials.');
    
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new Error(`Coveo token extraction timed out after ${timeout}ms`);
    }
    
    throw error;
  }
}

/**
 * Cache for Coveo tokens to avoid repeated fetches
 */
const tokenCache = new Map<string, CoveoTokenResponse>();

export async function getCachedCoveoToken(sapCookies: string, maxAgeMs: number = 5 * 60 * 1000): Promise<string> {
  const cached = tokenCache.get(sapCookies);
  
  if (cached && cached.expiresAt && Date.now() < cached.expiresAt) {
    logger.debug('🔄 Using cached Coveo token');
    return cached.token;
  }
  
  logger.debug('🔄 Fetching fresh Coveo token...');
  const token = await getCoveoTokenDirect(sapCookies);
  
  tokenCache.set(sapCookies, {
    token,
    expiresAt: Date.now() + maxAgeMs
  });
  
  return token;
}
















