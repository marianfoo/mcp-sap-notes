import { SapWebAuthenticator, type AuthConfig, type BrowserType, type ServiceProfile } from '@marianfoo/sap-mcp-auth';
import type { ServerConfig } from './types.js';
import { logger } from './logger.js';

function resolveBrowserType(value: string | undefined): BrowserType | undefined {
  return value === 'chromium' || value === 'firefox' || value === 'webkit' ? value : undefined;
}

/**
 * Build a SapWebAuthenticator configured for SAP Notes (me.sap.com).
 * Notes logs in directly on the SAP login page, keeps all cookies, and enables
 * the shared-SSO fast path so a valid SSO storage-state file is reused without
 * launching a browser. The persistent-browser note retrieval lives in
 * SapNotesApiClient and only consumes the resulting cookie header.
 */
export function createNotesAuthenticator(config: ServerConfig): SapWebAuthenticator {
  const authConfig: AuthConfig = {
    authMethod: config.authMethod,
    sapUsername: config.sapUsername,
    sapPassword: config.sapPassword,
    pfxPath: config.pfxPath || undefined,
    pfxPassphrase: config.pfxPassphrase || undefined,
    sapLoginUrl: config.sapLoginUrl ?? 'https://me.sap.com/home',
    mfaTimeout: config.mfaTimeout,
    maxSessionAgeH: config.maxJwtAgeH,
    headful: config.headful,
    tokenCacheFile: config.tokenCacheFile,
    ssoStorageStateFile: config.ssoStorageStateFile,
    browserType: resolveBrowserType(process.env.PLAYWRIGHT_BROWSER_TYPE),
    sharedSsoTokenFastPath: true,
    logger
  };

  const profile: ServiceProfile = {
    serviceName: 'SAP Notes',
    cookieScope: { type: 'all' }
  };

  return new SapWebAuthenticator(authConfig, profile);
}
