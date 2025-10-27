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
   * Invalidate current authentication and force fresh login
   * Call this when session cookies have expired or been rejected by SAP
   */
  invalidateAuth(): void {
    logger.warn('🗑️  Invalidating cached authentication');
    this.authState = { isAuthenticated: false };
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
   * Check if a specific browser is available with detailed debugging
   */
  private static async checkBrowserAvailable(browserType: string = 'chromium'): Promise<boolean> {
    try {
      const browsers = { chromium, firefox, webkit };
      const browser = browsers[browserType as keyof typeof browsers];
      if (!browser) {
        logger.error(`❌ Browser type '${browserType}' not found in Playwright`);
        return false;
      }
      
      // Try to get executable path with detailed debugging
      logger.warn(`🔍 Checking ${browserType} browser availability...`);
      const executablePath = await browser.executablePath();
      logger.warn(`✅ Browser executable found at: ${executablePath}`);
      
      // Check if executable actually exists
      const fs = await import('fs');
      if (!fs.existsSync(executablePath)) {
        logger.error(`❌ Browser executable not found at: ${executablePath}`);
        return false;
      }
      
      logger.warn(`✅ Browser executable verified at: ${executablePath}`);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`❌ Browser availability check failed for ${browserType}:`);
      logger.error(`   Error: ${errorMessage}`);
      
      // Add detailed debugging for Docker/container issues
      await SapAuthenticator.debugBrowserEnvironment(browserType);
      
      return false;
    }
  }

  /**
   * Debug browser environment for Docker/container issues
   */
  private static async debugBrowserEnvironment(browserType: string): Promise<void> {
    logger.error(`🔍 Debugging browser environment for ${browserType}:`);
    
    // Check environment variables
    const playwrightEnvVars = [
      'PLAYWRIGHT_BROWSERS_PATH',
      'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
      'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
      'PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH',
      'PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH'
    ];
    
    logger.error('   Environment variables:');
    playwrightEnvVars.forEach(envVar => {
      const value = process.env[envVar];
      logger.error(`     ${envVar}: ${value || 'NOT_SET'}`);
    });
    
    // Check if running in Docker
    const fs = await import('fs');
    const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/proc/self/cgroup');
    logger.error(`   Running in Docker: ${isDocker}`);
    
    // Check system information
    logger.error(`   Platform: ${process.platform}`);
    logger.error(`   Architecture: ${process.arch}`);
    logger.error(`   Node version: ${process.version}`);
    
    // Check for common browser paths
    const commonPaths = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser', 
      '/usr/bin/google-chrome',
      '/usr/bin/firefox',
      '/opt/google/chrome/chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ];
    
    logger.error('   System browser paths:');
    for (const path of commonPaths) {
      const exists = fs.existsSync(path);
      logger.error(`     ${path}: ${exists ? 'EXISTS' : 'NOT_FOUND'}`);
    }
    
    // Check Playwright cache directory
    const playwrightCache = process.env.PLAYWRIGHT_BROWSERS_PATH || 
                           `${process.env.HOME || '/root'}/.cache/ms-playwright`;
    logger.error(`   Playwright cache directory: ${playwrightCache}`);
    
    if (fs.existsSync(playwrightCache)) {
      try {
        const contents = fs.readdirSync(playwrightCache);
        logger.error(`     Contents: ${contents.join(', ')}`);
        
        // Check specific browser directories
        contents.forEach(item => {
          const itemPath = `${playwrightCache}/${item}`;
          if (fs.statSync(itemPath).isDirectory()) {
            logger.error(`     ${item}/: ${fs.readdirSync(itemPath).join(', ')}`);
          }
        });
      } catch (e) {
        logger.error(`     Error reading cache directory: ${e}`);
      }
    } else {
      logger.error('     Cache directory does not exist');
    }
    
    // Check for missing dependencies (Alpine Linux specific)
    if (isDocker) {
      logger.error('   Docker-specific checks:');
      const alpineDeps = [
        '/usr/lib/libnss3.so',
        '/usr/lib/libxss.so.1',
        '/usr/lib/libglib-2.0.so.0',
        '/lib/libpthread.so.0'
      ];
      
      alpineDeps.forEach(dep => {
        const exists = fs.existsSync(dep);
        logger.error(`     ${dep}: ${exists ? 'EXISTS' : 'MISSING'}`);
      });
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

      // Launch browser with retry logic for transient resource errors
      logger.warn('🎬 Browser launching...');
      logger.warn(`   Launch options: ${JSON.stringify(launchOptions, null, 2)}`);
      
      const maxRetries = 3;
      let lastError: Error | null = null;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          logger.warn(`🚀 Browser launch attempt ${attempt}/${maxRetries}...`);
          this.browser = await browserLauncher.launch(launchOptions);
          logger.warn(`✅ Browser launched successfully (attempt ${attempt}/${maxRetries})`);
          break;
        } catch (error) {
          lastError = error as Error;
          const errorMsg = error instanceof Error ? error.message : String(error);
          
          // Log the FULL error details for debugging
          logger.error(`❌ Browser launch failed (attempt ${attempt}/${maxRetries}):`);
          logger.error(`   Error type: ${error instanceof Error ? error.name : 'Unknown'}`);
          logger.error(`   Error message: ${errorMsg}`);
          
          if (error instanceof Error && error.stack) {
            logger.error(`   Stack trace: ${error.stack}`);
          }
          
          // Log additional error properties if available
          if (error && typeof error === 'object') {
            const errorObj = error as any;
            if (errorObj.code) logger.error(`   Error code: ${errorObj.code}`);
            if (errorObj.errno) logger.error(`   Error number: ${errorObj.errno}`);
            if (errorObj.syscall) logger.error(`   System call: ${errorObj.syscall}`);
            if (errorObj.path) logger.error(`   Path: ${errorObj.path}`);
          }
          
          // Debug browser environment on first failure
          if (attempt === 1) {
            await SapAuthenticator.debugBrowserEnvironment(browserType);
          }
          
          // Check if it's a resource exhaustion error
          if (errorMsg.includes('pthread_create') || errorMsg.includes('Resource temporarily unavailable')) {
            if (attempt < maxRetries) {
              const delayMs = Math.pow(2, attempt) * 1000; // Exponential backoff: 2s, 4s, 8s
              logger.warn(`⚠️ Resource exhaustion detected, retrying in ${delayMs/1000}s...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
              continue;
            }
          }
          
          // Check for executable not found errors (common in Docker)
          if (errorMsg.includes('Executable doesn\'t exist') || 
              errorMsg.includes('ENOENT') ||
              errorMsg.includes('No such file or directory')) {
            logger.error(`💡 Browser executable issue detected. Common Docker/Alpine Linux fixes:`);
            logger.error(`   1. Install Playwright browsers: npx playwright install chromium`);
            logger.error(`   2. Install system dependencies: apk add chromium nss freetype harfbuzz`);
            logger.error(`   3. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to system chromium`);
            logger.error(`   4. Check if running in headless mode works: HEADFUL=false`);
          }
          
          // Check for permission errors
          if (errorMsg.includes('EACCES') || errorMsg.includes('Permission denied')) {
            logger.error(`💡 Permission error detected. Common fixes:`);
            logger.error(`   1. Check file permissions on browser executable`);
            logger.error(`   2. Run with different user (non-root may be required)`);
            logger.error(`   3. Check Docker container security settings`);
          }
          
          // For Alpine Linux / Docker specific issues
          if (errorMsg.includes('error while loading shared libraries')) {
            logger.error(`💡 Shared library error detected. Alpine Linux fixes:`);
            logger.error(`   1. Install missing dependencies: apk add ${errorMsg.match(/lib\w+\.so[\.\d]*/g)?.join(' ')}`);
            logger.error(`   2. Install browser dependencies: apk add nss freetype harfbuzz ca-certificates`);
          }
          
          // If max retries reached, don't retry
          if (attempt >= maxRetries) {
            logger.error(`❌ Max retries (${maxRetries}) reached. Browser launch failed permanently.`);
            throw error;
          }
          
          // Wait before retry
          const delayMs = 1000;
          logger.warn(`⏳ Retrying in ${delayMs/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
      
      if (!this.browser) {
        const finalErrorMsg = `Failed to launch browser after ${maxRetries} attempts`;
        logger.error(`❌ ${finalErrorMsg}`);
        if (lastError) {
          logger.error(`   Last error: ${lastError.message}`);
        }
        throw new Error(`${finalErrorMsg}: ${lastError?.message || 'Unknown error'}`);
      }

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
          logger.warn(`📤 Request: ${request.method()} ${request.url().substring(0, 100)}`);
        }
      });
      
      this.page.on('response', response => {
        if (response.url().includes('sap.com')) {
          logger.warn(`📥 Response: ${response.status()} ${response.url().substring(0, 100)}`);
        }
      });
      
      this.page.on('dialog', dialog => {
        logger.warn(`💬 Dialog appeared: ${dialog.type()} ${dialog.message()}`);
        dialog.dismiss().catch(() => {}); // Dismiss any dialogs
      });
      
      this.page.on('console', msg => {
        if (msg.type() === 'error') {
          logger.warn(`🔴 Browser error: ${msg.text()}`);
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