import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import type { AuthState, ServerConfig } from './types.js';
import { logger } from './logger.js';

const TOKEN_CACHE_FILE = 'token-cache.json';

/**
 * Custom error classes for better error handling
 */
class BrowserNotFoundError extends Error {
  constructor(browserType: string, searchPaths: string[] = []) {
    super(`Browser ${browserType} not found${searchPaths.length ? ` in paths: ${searchPaths.join(', ')}` : ''}`);
    this.name = 'BrowserNotFoundError';
  }
}

class CertificateLoadError extends Error {
  constructor(certPath: string, originalError: Error) {
    super(`Failed to load certificate from ${certPath}: ${originalError.message}`);
    this.name = 'CertificateLoadError';
  }
}

class AuthenticationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Authentication timed out after ${timeoutMs}ms`);
    this.name = 'AuthenticationTimeoutError';
  }
}

class AuthenticationError extends Error {
  originalError?: Error;
  
  constructor(message: string, originalError?: Error) {
    super(message);
    this.name = 'AuthenticationError';
    this.originalError = originalError;
  }
}

export class SapAuthenticator {
  private authState: AuthState = { isAuthenticated: false };
  private authPromise: Promise<void> | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private config: ServerConfig) {}

  /**
   * Ensures authentication is valid, performing login if needed
   * Includes single-flight guard to prevent concurrent authentication attempts
   */
  async ensureAuthenticated(): Promise<string> {
    // Single-flight guard - if authentication is in progress, wait for it
    if (this.authPromise) {
      await this.authPromise;
    }

    // Check if current token is still valid
    if (this.isTokenValid()) {
      return this.authState.token!;
    }

    // Start new authentication flow
    this.authPromise = this.authenticate();
    await this.authPromise;
    this.authPromise = null;

    if (!this.authState.token) {
      throw new Error('Authentication failed - no token received');
    }

    return this.authState.token;
  }

  /**
   * Check if the current token is valid and not expired
   */
  private isTokenValid(): boolean {
    if (!this.authState.token || !this.authState.expiresAt) {
      return false;
    }

    // Add 5 minute buffer before expiry
    const bufferMs = 5 * 60 * 1000;
    return Date.now() < (this.authState.expiresAt - bufferMs);
  }

  /**
   * Check if a specific browser is available
   */
  private static async checkBrowserAvailable(browserType: string = 'chromium'): Promise<boolean> {
    try {
      const browsers = { chromium, firefox, webkit };
      const browser = browsers[browserType as keyof typeof browsers];
      if (!browser) return false;
      
      // Try to get executable path
      await browser.executablePath();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Validate certificate files
   */
  private static async validateCertificate(pfxPath: string, passphrase: string): Promise<boolean> {
    try {
      if (!existsSync(pfxPath)) {
        throw new Error(`Certificate file not found: ${pfxPath}`);
      }
      
      // Try to read the certificate file
      const certData = readFileSync(pfxPath);
      if (certData.length === 0) {
        throw new Error('Certificate file is empty');
      }
      
      return true;
    } catch (error) {
      throw new CertificateLoadError(pfxPath, error as Error);
    }
  }

  /**
   * Get the appropriate browser launcher
   */
  private getBrowserLauncher() {
    const browserType = process.env.PLAYWRIGHT_BROWSER_TYPE || 'chromium';
    const browsers = { chromium, firefox, webkit };
    const browser = browsers[browserType as keyof typeof browsers];
    
    if (!browser) {
      throw new BrowserNotFoundError(browserType);
    }
    
    return browser;
  }

  /**
   * Prepare client certificate configuration
   */
  private prepareClientCertificate() {
    const origin = 'https://accounts.sap.com';
    
    try {
      if (!existsSync(this.config.pfxPath)) {
        throw new Error(`PFX file not found: ${this.config.pfxPath}`);
      }

      const pfxData = readFileSync(this.config.pfxPath);
      logger.warn(`🔐 Loaded PFX certificate from: ${this.config.pfxPath}`);

      return {
        origin,
        pfx: pfxData,
        passphrase: this.config.pfxPassphrase
      };
    } catch (error) {
      throw new CertificateLoadError(this.config.pfxPath, error as Error);
    }
  }

  /**
   * Perform the full authentication flow using direct Playwright implementation
   */
  private async authenticate(): Promise<void> {
    // First try to load cached token
    const cachedToken = this.loadCachedToken();
    if (cachedToken && this.isTokenValidFromCache(cachedToken)) {
      logger.warn('🔄 Using cached SAP authentication token');
      this.authState = {
        token: cachedToken.access_token,
        expiresAt: cachedToken.expiresAt,
        isAuthenticated: true
      };
      return;
    }

    logger.warn('🔐 Starting SAP authentication flow...');

    const startTime = Date.now();
    
    try {
      // Validate certificate first
      await SapAuthenticator.validateCertificate(this.config.pfxPath, this.config.pfxPassphrase);
      
      // Check browser availability
      const browserLauncher = this.getBrowserLauncher();
      const browserType = process.env.PLAYWRIGHT_BROWSER_TYPE || 'chromium';
      
      if (!(await SapAuthenticator.checkBrowserAvailable(browserType))) {
        throw new BrowserNotFoundError(browserType);
      }

      logger.warn(`🔍 Using ${browserType} browser for authentication`);

      // Prepare client certificate
      const clientCertificate = this.prepareClientCertificate();

      // Prepare browser launch options
      const headless = process.env.HEADFUL !== 'true';
      const launchOptions = {
        headless,
        ignoreHTTPSErrors: true
      };

      logger.warn(`🚀 Launching browser (headless: ${headless})`);
      
      // Special handling for MCP mode - detect if we're running from Cursor
      const isMcpMode = !process.stdin.isTTY || !process.stdout.isTTY || process.env.MCP_MODE === 'true';
      if (isMcpMode && headless) {
        logger.warn('⚠️ Running in MCP mode with headless browser - authentication may fail');
        logger.warn('💡 Consider setting HEADFUL=true in your Cursor MCP configuration for debugging');
      }

      // Launch browser
      logger.warn('🎬 Browser launching...');
      this.browser = await browserLauncher.launch(launchOptions);
      logger.warn('✅ Browser launched successfully');

      // Prepare context options
      const contextOptions = {
        ignoreHTTPSErrors: true,
        clientCertificates: [clientCertificate],
        locale: 'en-US',
        viewport: { width: 1280, height: 720 }
      };

      logger.warn('🔧 Creating browser context with client certificate...');
      // Create a new context with the client certificate
      this.context = await this.browser.newContext(contextOptions);
      logger.warn('✅ Browser context created');
      
      logger.warn('📄 Creating new page...');
      this.page = await this.context.newPage();
      logger.warn('✅ Page created');

      // Add event listeners for debugging
      this.page.on('request', request => {
        if (request.url().includes('sap.com')) {
          logger.warn('📤 Request:', request.method(), request.url().substring(0, 100));
        }
      });
      
      this.page.on('response', response => {
        if (response.url().includes('sap.com')) {
          logger.warn('📥 Response:', response.status(), response.url().substring(0, 100));
        }
      });
      
      this.page.on('dialog', dialog => {
        logger.warn('💬 Dialog appeared:', dialog.type(), dialog.message());
        dialog.dismiss().catch(() => {}); // Dismiss any dialogs
      });
      
      this.page.on('console', msg => {
        if (msg.type() === 'error') {
          logger.warn('🔴 Browser error:', msg.text());
        }
      });

      // Navigate to SAP IAS for authentication
      const authUrl = 'https://me.sap.com/home';
      logger.warn('🔑 Authenticating with SAP Identity Service...');
      
      const timeout = 30000; // 30 seconds - reduced from 60s
      
      const navigationPromise = this.page.goto(authUrl, {
        waitUntil: 'domcontentloaded', // Less strict than networkidle
        timeout
      });
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new AuthenticationTimeoutError(timeout)), timeout);
      });

      await Promise.race([navigationPromise, timeoutPromise]);
      
      logger.warn('🔍 Page loaded, checking page state...');
      
      // Give it a moment to settle, then check for networkidle with shorter timeout
      try {
        logger.warn('⏳ Waiting for network activity to settle...');
        await this.page.waitForLoadState('networkidle', { timeout: 10000 });
        logger.warn('✅ Network settled');
      } catch (error) {
        logger.warn('⚠️ Network did not settle within 10s, continuing anyway');
      }
      
      // Get page title and URL to understand where we are
      const pageTitle = await this.page.title();
      const currentUrl = this.page.url();
      const currentUrlStr = currentUrl.toString();
      logger.warn('📄 Current page:', { title: pageTitle, url: currentUrlStr });
      
      // Take a screenshot for debugging (if headful mode)
      if (process.env.HEADFUL === 'true') {
        try {
          await this.page.screenshot({ path: 'debug-auth-page.png', fullPage: true });
          logger.warn('📸 Screenshot saved as debug-auth-page.png');
        } catch (e) {
          logger.warn('📸 Could not take screenshot:', e);
        }
      }
      
      // Check if we're still on a login page or if we need to wait for redirects
      if (currentUrlStr.includes('login') || currentUrlStr.includes('auth') || pageTitle.toLowerCase().includes('login')) {
        logger.warn('🔄 Still on login page, waiting for authentication redirect...');
        
        // Wait for navigation to complete (e.g., after certificate selection)
        try {
          await this.page.waitForURL(url => !url.toString().includes('login') && !url.toString().includes('auth'), { 
            timeout: 30000 
          });
          logger.warn('✅ Authentication redirect completed');
        } catch (error) {
          logger.warn('⚠️ No redirect detected, continuing with current page');
        }
      }
      
      logger.warn('✅ SAP IAS authentication completed');

      // Wait a moment for any additional cookies to be set
      logger.warn('⏳ Waiting for any additional authentication steps...');
      await this.page.waitForTimeout(3000);

      // Extract authenticated cookies from SAP session
      logger.warn('🍪 Extracting authentication cookies from SAP session...');
      
      const allCookies = await this.context.cookies();
      logger.warn(`🍪 Retrieved ${allCookies.length} cookies from SAP authentication`);
      
      // Create cookie string for API calls
      const cookieString = allCookies.map(cookie => 
        `${cookie.name}=${cookie.value}`
      ).join('; ');
      
      // Calculate expiry time
      const expiresAt = Date.now() + (this.config.maxJwtAgeH * 60 * 60 * 1000);

      // Save authentication state using cookie-based approach
      this.authState = {
        token: cookieString,
        expiresAt,
        isAuthenticated: true
      };

      // Cache the cookies for future use
      this.saveCachedToken({
        access_token: cookieString,
        cookies: allCookies,
        expiresAt
      });

      const duration = Date.now() - startTime;
      logger.warn(`✅ SAP authentication completed successfully in ${duration}ms`);

    } catch (error) {
      logger.error('Authentication failed:', error);
      if (error instanceof Error) {
        logger.error('Error message:', error.message);
      }
      this.authState = { isAuthenticated: false };
      
      // Re-throw with appropriate error type
      if (error instanceof AuthenticationTimeoutError || 
          error instanceof CertificateLoadError || 
          error instanceof BrowserNotFoundError) {
        throw error;
      } else {
        throw new AuthenticationError('Authentication process failed', error as Error);
      }
    } finally {
      // Always clean up the browser
      await this.cleanup();
    }
  }

  /**
   * Clean up browser resources
   */
  private async cleanup(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        logger.warn('🧹 Browser session closed');
      } catch (closeError) {
        logger.error('Error closing browser:', closeError);
      } finally {
        this.browser = null;
        this.context = null;
        this.page = null;
      }
    }
  }

  /**
   * Load cached token from disk
   */
  private loadCachedToken(): any {
    try {
      if (existsSync(TOKEN_CACHE_FILE)) {
        const cached = JSON.parse(readFileSync(TOKEN_CACHE_FILE, 'utf-8'));
        return cached;
      }
    } catch (error) {
      logger.warn('Failed to load cached token:', error);
    }
    return null;
  }

  /**
   * Check if cached token is still valid
   */
  private isTokenValidFromCache(cachedToken: any): boolean {
    if (!cachedToken.access_token || !cachedToken.expiresAt) {
      return false;
    }

    // Add 5 minute buffer before expiry
    const bufferMs = 5 * 60 * 1000;
    return Date.now() < (cachedToken.expiresAt - bufferMs);
  }

  /**
   * Save token to disk cache
   */
  private saveCachedToken(tokenData: any): void {
    try {
      writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(tokenData, null, 2));
      logger.warn('💾 Token cached for future use');
    } catch (error) {
      logger.warn('Failed to cache token:', error);
    }
  }

  /**
   * Force cleanup and reset authentication state
   */
  async destroy(): Promise<void> {
    this.authState = { isAuthenticated: false };
    await this.cleanup();
    
    // Clean up cached token
    try {
      if (existsSync(TOKEN_CACHE_FILE)) {
        // Could delete the file or leave it for next time
        // unlinkSync(TOKEN_CACHE_FILE);
      }
    } catch (error) {
      logger.warn('Error cleaning up cache:', error);
    }
  }
} 