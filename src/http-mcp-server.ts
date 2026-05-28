import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute, resolve } from 'path';
import { existsSync } from 'fs';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerConfig } from './types.js';
import type { SapWebAuthenticator } from '@marianzeis/sap-mcp-auth';
import { createNotesAuthenticator } from './auth.js';
import { SapNotesApiClient } from './sap-notes-api.js';
import { logger } from './logger.js';
import {
  NoteSearchInputSchema,
  NoteSearchOutputSchema,
  NoteGetInputSchema,
  NoteGetOutputSchema,
  SAP_NOTE_SEARCH_DESCRIPTION,
  SAP_NOTE_GET_DESCRIPTION
} from './schemas/sap-notes.js';
import { parseNoteContent } from './html-utils.js';

// Get the directory of this module for resolving paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveOptionalPath(value: string | undefined): string | undefined {
  if (!value) return undefined;

  let resolvedPath = value;
  if (resolvedPath.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    resolvedPath = join(home, resolvedPath.slice(2));
  }

  if (!isAbsolute(resolvedPath)) {
    resolvedPath = join(__dirname, '..', resolvedPath);
  }

  return resolve(resolvedPath);
}

// Load environment variables from an explicit file, the launch CWD, then the project root.
const configuredEnvFile = process.env.ENV_FILE;
if (configuredEnvFile) {
  config({ path: resolveOptionalPath(configuredEnvFile) });
} else {
  config();
  config({ path: join(__dirname, '..', '.env') });
}

/**
 * SAP Note MCP HTTP Server using the MCP SDK
 * Uses StreamableHTTPServerTransport in stateless mode.
 * A fresh McpServer is created per request to avoid connect() collisions.
 */
class HttpSapNoteMcpServer {
  private config: ServerConfig;
  private authenticator: SapWebAuthenticator;
  private sapNotesClient: SapNotesApiClient;
  private app: express.Application;
  private server: any;

  constructor() {
    this.config = this.loadConfig();
    this.authenticator = createNotesAuthenticator(this.config);
    this.sapNotesClient = new SapNotesApiClient(this.config);

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Load configuration from environment variables
   */
  private loadConfig(): ServerConfig {
    const authMethod = (process.env.AUTH_METHOD || 'auto') as 'certificate' | 'password' | 'auto';
    const sapUsername = process.env.SAP_USERNAME;
    const sapPassword = process.env.SAP_PASSWORD;
    const pfxPath = resolveOptionalPath(process.env.PFX_PATH) || '';
    const pfxPassphrase = process.env.PFX_PASSPHRASE || '';
    const hasCertConfig = !!(pfxPath && pfxPassphrase);
    const hasPasswordConfig = !!(sapUsername && sapPassword);
    const projectRoot = join(__dirname, '..');
    const tokenCacheFile = resolveOptionalPath(
      process.env.SAP_NOTES_TOKEN_CACHE_FILE ||
      process.env.TOKEN_CACHE_FILE ||
      join(projectRoot, 'token-cache.json')
    )!;
    const ssoStorageStateFile = resolveOptionalPath(
      process.env.SAP_SSO_STORAGE_STATE ||
      join(process.env.HOME || process.cwd(), '.sap-mcp', 'sso-storage-state.json')
    );
    const hasSsoStorageState = !!(ssoStorageStateFile && existsSync(ssoStorageStateFile));

    if (!hasCertConfig && !hasPasswordConfig && !ssoStorageStateFile) {
      throw new Error(
        'No authentication configured. Set either SAP_USERNAME + SAP_PASSWORD for password auth, ' +
        'PFX_PATH + PFX_PASSPHRASE for certificate auth, or SAP_SSO_STORAGE_STATE for shared SSO.'
      );
    }

    if (!process.env.ACCESS_TOKEN) {
      logger.warn('ACCESS_TOKEN not set - server will run WITHOUT endpoint authentication');
    }

    const isDocker = process.env.DOCKER_ENV === 'true' ||
                    process.env.NODE_ENV === 'production' ||
                    !process.env.DISPLAY ||
                    !process.stdin.isTTY ||
                    process.env.CI === 'true';

    const headful = !isDocker && process.env.HEADFUL === 'true';

    logger.warn('Configuration loaded:', {
      authMethod,
      hasPassword: hasPasswordConfig,
      hasCertificate: hasCertConfig,
      hasSsoStorageState,
      ssoStorageStateFile,
      headful
    });

    return {
      pfxPath,
      pfxPassphrase,
      sapUsername,
      sapPassword,
      authMethod,
      mfaTimeout: parseInt(process.env.MFA_TIMEOUT || '120000'),
      maxJwtAgeH: parseInt(process.env.MAX_JWT_AGE_H || '12'),
      headful,
      logLevel: process.env.LOG_LEVEL || 'info',
      tokenCacheFile,
      ssoStorageStateFile,
      sapLoginUrl: process.env.SAP_LOGIN_URL || 'https://me.sap.com/home'
    };
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    this.app.use(cors({
      origin: '*',
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'],
      exposedHeaders: ['Mcp-Session-Id'],
      credentials: false
    }));

    this.app.use(express.json());

    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`);
      next();
    });
  }

  /**
   * Simple bearer token authentication middleware
   */
  private authMiddleware = (req: express.Request, res: express.Response, next: Function): void => {
    const accessToken = process.env.ACCESS_TOKEN;

    if (!accessToken || accessToken.trim() === '') {
      logger.debug('No ACCESS_TOKEN configured - allowing request without authentication');
      return next();
    }

    const authHeader = req.headers.authorization;
    const bearerHeader = req.headers.bearer as string | undefined;

    let token: string | undefined;

    if (bearerHeader) {
      token = bearerHeader;
    } else if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
      }
    }

    if (!token) {
      res.status(401).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: { code: -32001, message: 'Unauthorized: Missing or invalid authorization' }
      });
      return;
    }

    if (token !== accessToken) {
      res.status(401).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: { code: -32001, message: 'Unauthorized: Invalid access token' }
      });
      return;
    }

    next();
  };

  /**
   * Execute an API call with automatic auth retry on session expiry.
   */
  private async withAuthRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const { cookieHeader } = await this.authenticator.ensureSession();
    try {
      return await fn(cookieHeader);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('SESSION_EXPIRED') || msg.includes('401') || msg.includes('Unauthorized') || msg.includes('session expired')) {
        logger.warn('Session expired, re-authenticating and retrying...');
        this.authenticator.invalidateAuth();
        const { cookieHeader: newCookie } = await this.authenticator.ensureSession();
        return await fn(newCookie);
      }
      throw error;
    }
  }

  /**
   * Create a fresh McpServer instance with all tools registered.
   * Called per-request in stateless mode so connect() is always on a new server.
   */
  private createMcpServer(): McpServer {
    const mcp = new McpServer({
      name: 'sap-note-search-mcp',
      version: '0.3.0'
    });

    // ─── search ──────────────────────────────────────────────────
    mcp.registerTool(
      'search',
      {
        title: 'Search SAP Notes',
        description: SAP_NOTE_SEARCH_DESCRIPTION,
        inputSchema: NoteSearchInputSchema,
        outputSchema: NoteSearchOutputSchema
      },
      async ({ q, lang = 'EN' }) => {
        logger.info(`🔎 [search] Starting search for query: "${q}"`);

        try {
          const searchResponse = await this.withAuthRetry(token =>
            this.sapNotesClient.searchNotes(q, token, 10)
          );

          const output = {
            totalResults: searchResponse.totalResults,
            query: searchResponse.query,
            results: searchResponse.results.map(note => ({
              id: note.id,
              title: note.title,
              summary: note.summary,
              component: note.component || null,
              releaseDate: note.releaseDate,
              language: note.language,
              url: note.url
            }))
          };

          let resultText = `Found ${output.totalResults} SAP Note(s) for query: "${output.query}"\n\n`;

          for (const note of output.results) {
            resultText += `**SAP Note ${note.id}**\n`;
            resultText += `Title: ${note.title}\n`;
            resultText += `Summary: ${note.summary}\n`;
            resultText += `Component: ${note.component || 'Not specified'}\n`;
            resultText += `Release Date: ${note.releaseDate}\n`;
            resultText += `Language: ${note.language}\n`;
            resultText += `URL: ${note.url}\n\n`;
          }

          logger.info(`✅ [search] Returning ${output.totalResults} results`);

          return {
            content: [{ type: 'text', text: resultText }],
            structuredContent: output
          };
        } catch (error) {
          logger.error('❌ Search failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown search error';
          return {
            content: [{ type: 'text', text: `Search failed: ${errorMessage}` }],
            isError: true
          };
        }
      }
    );

    // ─── fetch ───────────────────────────────────────────────────
    mcp.registerTool(
      'fetch',
      {
        title: 'Fetch SAP Note',
        description: SAP_NOTE_GET_DESCRIPTION,
        inputSchema: NoteGetInputSchema,
        outputSchema: NoteGetOutputSchema
      },
      async ({ id, lang = 'EN', includeCorrections = false }) => {
        logger.info(`📄 [fetch] Getting note ${id} (includeCorrections=${includeCorrections})`);

        try {
          const noteDetail = await this.withAuthRetry(token =>
            this.sapNotesClient.getNote(id, token)
          );

          if (!noteDetail) {
            return {
              content: [{ type: 'text', text: `SAP Note ${id} not found or not accessible.` }],
              isError: true
            };
          }

          // Optionally fetch correction instruction details via OData
          if (includeCorrections && noteDetail.correctionsSummary && noteDetail.correctionsSummary.length > 0) {
            try {
              const corrections = await this.withAuthRetry(token =>
                this.sapNotesClient.getCorrectionDetails(id, noteDetail.correctionsSummary!, token)
              );
              if (corrections && corrections.length > 0) {
                (noteDetail as any).correctionDetails = corrections;
              }
            } catch (corrError) {
              logger.warn(`⚠️ Correction details fetch failed (non-fatal): ${corrError instanceof Error ? corrError.message : String(corrError)}`);
            }
          }

          const parsed = parseNoteContent(noteDetail.content);

          const output: Record<string, any> = {
            id: noteDetail.id,
            title: noteDetail.title,
            summary: noteDetail.summary,
            component: noteDetail.component || null,
            componentText: noteDetail.componentText || null,
            priority: noteDetail.priority || null,
            category: noteDetail.category || null,
            version: noteDetail.version != null ? String(noteDetail.version) : null,
            status: noteDetail.status || null,
            releaseDate: noteDetail.releaseDate,
            language: noteDetail.language,
            url: noteDetail.url,
            content: parsed.plainText || noteDetail.content
          };

          // Add enriched metadata only when present
          if (noteDetail.validity?.length) output.validity = noteDetail.validity;
          if (noteDetail.supportPackages?.length) output.supportPackages = noteDetail.supportPackages;
          if (noteDetail.supportPackagePatches?.length) output.supportPackagePatches = noteDetail.supportPackagePatches;
          if (noteDetail.references) output.references = noteDetail.references;
          if (noteDetail.prerequisites?.length) output.prerequisites = noteDetail.prerequisites;
          if (noteDetail.sideEffects) output.sideEffects = noteDetail.sideEffects;
          if (noteDetail.correctionsInfo) output.correctionsInfo = noteDetail.correctionsInfo;
          if (noteDetail.correctionsSummary?.length) output.correctionsSummary = noteDetail.correctionsSummary;
          if ((noteDetail as any).correctionDetails?.length) output.correctionDetails = (noteDetail as any).correctionDetails;
          if (noteDetail.manualActions) output.manualActions = noteDetail.manualActions;
          if (noteDetail.attachments?.length) output.attachments = noteDetail.attachments;
          if (noteDetail.downloadUrl) output.downloadUrl = noteDetail.downloadUrl;

          // Format display text
          let resultText = `**SAP Note ${output.id} - ${output.title}**\n\n`;
          resultText += `Component: ${output.componentText || output.component || 'Not specified'} | `;
          resultText += `Priority: ${output.priority || 'Not specified'} | `;
          resultText += `Category: ${output.category || 'Not specified'} | `;
          resultText += `Released: ${output.releaseDate}`;
          if (output.version) resultText += ` | Version: ${output.version}`;
          resultText += `\nURL: ${output.url}\n\n`;
          resultText += output.content + '\n';

          if (output.validity?.length) {
            resultText += `\n**Validity:** ${output.validity.map((v: any) => `${v.softwareComponent} ${v.versionFrom}-${v.versionTo}`).join(', ')}\n`;
          }
          if (output.correctionsInfo) {
            const ci = output.correctionsInfo;
            resultText += `\n**Corrections:** ${ci.totalCorrections ?? '?'} corrections, ${ci.totalManualActivities ?? 0} manual activities, ${ci.totalPrerequisites ?? 0} prerequisites\n`;
          }
          if (output.prerequisites?.length) {
            resultText += `\n**Prerequisites:** ${output.prerequisites.map((p: any) => `Note ${p.noteNumber}`).join(', ')}\n`;
          }
          if (output.correctionDetails?.length) {
            resultText += `\n**Correction Details (${output.correctionDetails.length} entries):**\n`;
            for (const cd of output.correctionDetails) {
              resultText += `  • ${cd.softwareComponent} ${cd.versionFrom}-${cd.versionTo}`;
              if (cd.objects?.length) {
                resultText += ` — ${cd.objects.length} objects (${cd.objects.slice(0, 3).map((o: any) => `${o.objectType} ${o.objectName}`).join(', ')}${cd.objects.length > 3 ? '...' : ''})`;
              }
              resultText += '\n';
            }
          }

          logger.info(`✅ [fetch] Successfully retrieved note ${id}`);

          return {
            content: [{ type: 'text', text: resultText }],
            structuredContent: output
          };
        } catch (error) {
          logger.error(`❌ Note retrieval failed for ${id}:`, error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown retrieval error';
          return {
            content: [{ type: 'text', text: `Failed to retrieve SAP Note ${id}: ${errorMessage}` }],
            isError: true
          };
        }
      }
    );

    return mcp;
  }

  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: express.Request, res: express.Response) => {
      res.json({
        status: 'healthy',
        server: 'sap-note-search-mcp',
        version: '0.3.0',
        protocol: 'streamable-http',
        tools: ['search', 'fetch']
      });
    });

    // MCP endpoint — stateless: new McpServer + transport per request
    const mcpHandler = async (req: express.Request, res: express.Response) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
          enableJsonResponse: false
        });

        const mcp = this.createMcpServer();

        res.on('close', () => {
          transport.close();
        });

        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Error handling MCP request: ${msg}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          });
        }
      }
    };

    this.app.get('/mcp', this.authMiddleware, mcpHandler);
    this.app.post('/mcp', this.authMiddleware, mcpHandler);
    this.app.delete('/mcp', this.authMiddleware, mcpHandler);

    this.app.options('/mcp', (_req: express.Request, res: express.Response) => {
      res.status(200).end();
    });
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    const port = process.env.HTTP_PORT || 3123;

    logger.warn('🚀 Starting HTTP SAP Note MCP Server');
    logger.warn(`📡 Server will be available at: http://localhost:${port}/mcp`);

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        logger.warn(`🌐 HTTP MCP Server running on port ${port}`);
        logger.warn(`🔗 MCP endpoint: http://localhost:${port}/mcp`);
        logger.warn(`💡 Health check: http://localhost:${port}/health`);
        logger.warn('✅ Server ready to accept connections');
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('HTTP server stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down HTTP MCP server...');
    try {
      await this.stop();
      await this.sapNotesClient.cleanup();
      await this.authenticator.destroy();
      logger.info('Server shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
    process.exit(0);
  }
}

// Start server if this file is run directly (ESM-safe, cross-platform)
const isDirectRun = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
    return thisFile === invoked;
  } catch {
    return false;
  }
})();

const shouldStart = isDirectRun || process.env.AUTO_START === 'true';

if (shouldStart) {
  const server = new HttpSapNoteMcpServer();

  process.on('SIGINT', () => server.shutdown());
  process.on('SIGTERM', () => server.shutdown());

  server.start().catch((error) => {
    logger.error('Failed to start HTTP server:', error);
    process.exit(1);
  });
}

export { HttpSapNoteMcpServer };
