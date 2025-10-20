import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerConfig } from './types.js';
import { SapAuthenticator } from './auth.js';
import { SapNotesApiClient } from './sap-notes-api.js';
import { logger } from './logger.js';

// Get the directory of this module for resolving paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the project root
config({ path: join(__dirname, '..', '.env') });

/**
 * SAP Note MCP HTTP Server using the official MCP SDK
 * This implementation uses the latest MCP protocol with Streamable HTTP transport
 */
class HttpSapNoteMcpServerOfficial {
  private config: ServerConfig;
  private authenticator: SapAuthenticator;
  private sapNotesClient: SapNotesApiClient;
  private mcpServer: McpServer;
  private app: express.Application;
  private server: any;

  constructor() {
    this.config = this.loadConfig();
    this.authenticator = new SapAuthenticator(this.config);
    this.sapNotesClient = new SapNotesApiClient(this.config);
    
    // Create MCP server with official SDK
    this.mcpServer = new McpServer({
      name: 'sap-note-search-mcp',
      version: '0.3.0'
    });

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupTools();
  }

  /**
   * Load configuration from environment variables
   */
  private loadConfig(): ServerConfig {
    const requiredEnvVars = ['PFX_PATH', 'PFX_PASSPHRASE'];
    const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    // Warn if ACCESS_TOKEN is not set (optional but recommended)
    if (!process.env.ACCESS_TOKEN) {
      logger.warn('⚠️  ACCESS_TOKEN not set - server will run WITHOUT authentication');
      logger.warn('⚠️  Set ACCESS_TOKEN in .env to enable bearer token authentication');
    }

    // Resolve PFX path relative to the project root (where package.json is)
    const projectRoot = join(__dirname, '..');
    let pfxPath = process.env.PFX_PATH!;

    // Expand tilde to user home on all platforms
    if (pfxPath.startsWith('~')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      pfxPath = join(home, pfxPath.slice(2));
    }

    // If it's not absolute, resolve against project root (works on win32 and posix)
    if (!isAbsolute(pfxPath)) {
      pfxPath = join(projectRoot, pfxPath);
    }

    logger.warn('🔧 Configuration loaded:', {
      pfxPath: pfxPath,
      projectRoot: projectRoot,
      workingDir: process.cwd()
    });

    return {
      pfxPath: pfxPath,
      pfxPassphrase: process.env.PFX_PASSPHRASE!,
      maxJwtAgeH: parseInt(process.env.MAX_JWT_AGE_H || '12'),
      headful: process.env.HEADFUL === 'true',
      logLevel: process.env.LOG_LEVEL || 'info'
    };
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // Enable CORS for all routes
    this.app.use(cors({
      origin: '*', // Allow all origins for development
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'],
      exposedHeaders: ['Mcp-Session-Id'],
      credentials: false
    }));

    // Parse JSON bodies
    this.app.use(express.json());

    // Logging middleware
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
    
    // If no token is configured or it's empty, allow all requests
    if (!accessToken || accessToken.trim() === '') {
      logger.debug('🔓 No ACCESS_TOKEN configured - allowing request without authentication');
      return next();
    }

    // Try multiple header sources (supports Microsoft Power Platform proxy and standard clients)
    const authHeader = req.headers.authorization;
    const bearerHeader = req.headers.bearer as string | undefined;
    
    let token: string | undefined;
    
    // Option 1: Check custom 'bearer' header (Microsoft Power Platform style)
    if (bearerHeader) {
      token = bearerHeader;
      logger.info(`🔑 Token found in 'bearer' header (Power Platform style)`);
    }
    // Option 2: Standard 'Authorization: Bearer <token>' header
    else if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
        logger.info(`🔑 Token found in 'Authorization' header (standard format)`);
      } else {
        logger.warn(`⚠️  Authorization header present but invalid format: "${authHeader}"`);
      }
    }
    
    // No valid token found
    if (!token) {
      logger.warn('❌ Authentication failed: No valid token in headers');
      logger.info(`🔍 Headers checked: authorization="${authHeader}", bearer="${bearerHeader}"`);
      res.status(401).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: {
          code: -32001,
          message: 'Unauthorized: Missing or invalid authorization',
          data: 'Provide token in "Authorization: Bearer <token>" header or "bearer" header'
        }
      });
      return;
    }

    // Validate the token
    if (token !== accessToken) {
      logger.warn(`❌ Authentication failed: Invalid token (length: ${token.length})`);
      res.status(401).json({
        jsonrpc: '2.0',
        id: req.body?.id || null,
        error: {
          code: -32001,
          message: 'Unauthorized: Invalid access token'
        }
      });
      return;
    }

    // Token is valid, proceed
    logger.info('✅ Authentication successful');
    next();
  };

  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Health check endpoint
    this.app.get('/health', (req: express.Request, res: express.Response) => {
      res.json({ 
        status: 'healthy',
        server: 'sap-note-search-mcp',
        version: '0.3.0',
        sdk: 'official-mcp-sdk-v1.20.0',
        protocol: 'streamable-http-latest',
        implementation: 'official'
      });
    });

    // MCP endpoint - handles all MCP JSON-RPC requests (with auth middleware)
    this.app.post('/mcp', this.authMiddleware, async (req: express.Request, res: express.Response) => {
      try {
        // Create a new transport for each request to prevent request ID collisions
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });

        res.on('close', () => {
          transport.close();
        });

        await this.mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error'
            },
            id: null
          });
        }
      }
    });

    // Handle preflight OPTIONS requests
    this.app.options('/mcp', (req: express.Request, res: express.Response) => {
      res.status(200).end();
    });
  }

  /**
   * Setup MCP tools using the official SDK
   */
  private setupTools(): void {
    // SAP Note Search Tool
    this.mcpServer.registerTool(
      'sap_note_search',
      {
        title: 'Search SAP Notes',
        description: 'Search SAP Notes / KB articles by free text or note ID. Returns a list of matching notes with metadata.',
        inputSchema: {
          q: z.string().describe('Query string or Note ID (e.g. "2744792" or "OData gateway error")'),
          lang: z.enum(['EN', 'DE']).default('EN').describe('Language code for search results')
        },
        outputSchema: {
          totalResults: z.number().describe('Total number of search results found'),
          query: z.string().describe('The search query that was executed'),
          results: z.array(z.object({
            id: z.string().describe('SAP Note ID'),
            title: z.string().describe('Note title'),
            summary: z.string().describe('Brief summary of the note'),
            component: z.string().nullable().describe('SAP component this note relates to'),
            releaseDate: z.string().describe('Date when the note was released'),
            language: z.string().describe('Language of the note content'),
            url: z.string().describe('Direct URL to the SAP Note')
          })).describe('Array of matching SAP Notes')
        }
      },
      async ({ q, lang = 'EN' }) => {
        logger.info(`🔎 [sap_note_search] Starting search for query: "${q}"`);
        
        try {
          // Ensure authentication
          logger.warn('🔐 Starting authentication for search...');
          const token = await this.authenticator.ensureAuthenticated();
          logger.warn('✅ Authentication successful for search');

          // Execute search
          const searchResponse = await this.sapNotesClient.searchNotes(q, token, 10);

          // Format results
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

          // Format display text
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

          logger.info(`✅ [sap_note_search] Successfully completed search, returning ${output.totalResults} results`);

          return {
            content: [{ type: 'text', text: resultText }],
            structuredContent: output
          };

        } catch (error) {
          logger.error('❌ Search failed:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown search error';
          
          return {
            content: [{ 
              type: 'text', 
              text: `Search failed: ${errorMessage}` 
            }],
            isError: true
          };
        }
      }
    );

    // SAP Note Get Tool
    this.mcpServer.registerTool(
      'sap_note_get',
      {
        title: 'Get SAP Note Details',
        description: 'Fetch full metadata and HTML content for a specific SAP Note by ID.',
        inputSchema: {
          id: z.string().regex(/^[0-9]{6,8}$/, 'SAP Note ID must be 6-8 digits').describe('SAP Note ID (6-8 digits)'),
          lang: z.enum(['EN', 'DE']).default('EN').describe('Language code for note content')
        },
        outputSchema: {
          id: z.string().describe('SAP Note ID'),
          title: z.string().describe('Note title'),
          summary: z.string().describe('Brief summary of the note'),
          component: z.string().nullable().describe('SAP component this note relates to'),
          priority: z.string().nullable().describe('Priority level of the note'),
          category: z.string().nullable().describe('Category classification'),
          releaseDate: z.string().describe('Date when the note was released'),
          language: z.string().describe('Language of the note content'),
          url: z.string().describe('Direct URL to the SAP Note'),
          content: z.string().describe('Full HTML content of the note')
        }
      },
      async ({ id, lang = 'EN' }) => {
        logger.info(`📄 [sap_note_get] Getting note details for ID: ${id}`);
        
        try {
          // Ensure authentication
          logger.warn('🔐 Starting authentication for note retrieval...');
          const token = await this.authenticator.ensureAuthenticated();
          logger.warn('✅ Authentication successful for note retrieval');

          // Get note details
          const noteDetail = await this.sapNotesClient.getNote(id, token);

          if (!noteDetail) {
            return {
              content: [{ 
                type: 'text', 
                text: `SAP Note ${id} not found or not accessible.` 
              }],
              isError: true
            };
          }

          // Structure the output
          const output = {
            id: noteDetail.id,
            title: noteDetail.title,
            summary: noteDetail.summary,
            component: noteDetail.component || null,
            priority: noteDetail.priority || null,
            category: noteDetail.category || null,
            releaseDate: noteDetail.releaseDate,
            language: noteDetail.language,
            url: noteDetail.url,
            content: noteDetail.content
          };

          // Format display text
          let resultText = `**SAP Note ${output.id} - Detailed Information**\n\n`;
          resultText += `**Title:** ${output.title}\n`;
          resultText += `**Summary:** ${output.summary}\n`;
          resultText += `**Component:** ${output.component || 'Not specified'}\n`;
          resultText += `**Priority:** ${output.priority || 'Not specified'}\n`;
          resultText += `**Category:** ${output.category || 'Not specified'}\n`;
          resultText += `**Release Date:** ${output.releaseDate}\n`;
          resultText += `**Language:** ${output.language}\n`;
          resultText += `**URL:** ${output.url}\n\n`;
          resultText += `**Content:**\n${output.content}\n\n`;

          logger.info(`✅ [sap_note_get] Successfully retrieved note ${id}`);

          return {
            content: [{ type: 'text', text: resultText }],
            structuredContent: output
          };

        } catch (error) {
          logger.error(`❌ Note retrieval failed for ${id}:`, error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown retrieval error';
          
          return {
            content: [{ 
              type: 'text', 
              text: `Failed to retrieve SAP Note ${id}: ${errorMessage}` 
            }],
            isError: true
          };
        }
      }
    );
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    const port = process.env.HTTP_PORT || 3123;
    
    logger.warn('🚀 Starting HTTP SAP Note MCP Server (Official SDK)');
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
    const invoked = process.argv[1] ? join(process.cwd(), process.argv[1]) : '';
    const matches = thisFile === invoked;
    
    // Debug output to help troubleshooting
    if (process.env.DEBUG_START === 'true') {
      console.error('🔍 Direct run check:');
      console.error('  thisFile:', thisFile);
      console.error('  invoked:', invoked);
      console.error('  matches:', matches);
    }
    
    return matches;
  } catch (error) {
    if (process.env.DEBUG_START === 'true') {
      console.error('❌ Error in isDirectRun check:', error);
    }
    return false;
  }
})();

// Start server if:
// 1. File is run directly, OR
// 2. AUTO_START environment variable is set to 'true'
const shouldStart = isDirectRun || process.env.AUTO_START === 'true';

if (process.env.DEBUG_START === 'true') {
  console.error('🚦 Should start server:', shouldStart);
  console.error('   - isDirectRun:', isDirectRun);
  console.error('   - AUTO_START:', process.env.AUTO_START);
}

if (shouldStart) {
  const server = new HttpSapNoteMcpServerOfficial();
  
  // Handle process termination gracefully
  process.on('SIGINT', () => server.shutdown());
  process.on('SIGTERM', () => server.shutdown());
  
  server.start().catch((error) => {
    logger.error('Failed to start HTTP server:', error);
    process.exit(1);
  });
} else if (process.env.DEBUG_START === 'true') {
  console.error('⏸️  Server not started (module imported, not run directly)');
}

export { HttpSapNoteMcpServerOfficial };
