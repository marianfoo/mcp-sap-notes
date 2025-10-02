import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import express, { Request, Response } from 'express';
import cors from 'cors';
import type { 
  SapNoteSearchParams, 
  SapNoteGetParams,
  ServerConfig 
} from './types.js';
import { SAP_NOTE_SEARCH_SCHEMA, SAP_NOTE_GET_SCHEMA } from './types.js';
import { SapAuthenticator } from './auth.js';
import { SapNotesApiClient } from './sap-notes-api.js';
import { logger } from './logger.js';
import Ajv from 'ajv';

// Get the directory of this module for resolving paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the project root
config({ path: join(__dirname, '..', '.env') });

// JSON Schema validator
const ajv = new Ajv({ allErrors: true });
const validateSearchParams = ajv.compile(SAP_NOTE_SEARCH_SCHEMA);
const validateGetParams = ajv.compile(SAP_NOTE_GET_SCHEMA);

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

class HttpSapNoteMcpServer {
  private config: ServerConfig;
  private authenticator: SapAuthenticator;
  private sapNotesClient: SapNotesApiClient;
  private isInitialized = false;
  private app: express.Application;
  private server: any;

  constructor() {
    this.config = this.loadConfig();
    this.authenticator = new SapAuthenticator(this.config);
    this.sapNotesClient = new SapNotesApiClient(this.config);
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
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
      allowedHeaders: ['Content-Type', 'Authorization'],
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
   * Validates the Authorization header against ACCESS_TOKEN from env
   */
  private authMiddleware = (req: Request, res: Response, next: Function): void => {
    const accessToken = process.env.ACCESS_TOKEN;
    
    // If no token is configured or it's empty, allow all requests
    if (!accessToken || accessToken.trim() === '') {
      logger.debug('🔓 No ACCESS_TOKEN configured - allowing request without authentication');
      return next();
    }

    // Try multiple header sources (supports Microsoft Power Platform proxy and standard clients)
    const authHeader = req.headers.authorization;
    const bearerHeader = req.headers.bearer as string | undefined;  // Non-standard but used by some proxies
    
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
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ 
        status: 'healthy',
        server: 'sap-note-search-mcp',
        version: '0.2.0',
        initialized: this.isInitialized
      });
    });

    // MCP endpoint - handles all MCP JSON-RPC requests (with auth middleware)
    this.app.post('/mcp', this.authMiddleware, async (req: Request, res: Response) => {
      try {
        const result = await this.handleMessage(req.body);
        res.json(result);
      } catch (error) {
        logger.error('Error handling MCP request:', error);
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id,
          error: {
            code: -32603,
            message: 'Internal error',
            data: error instanceof Error ? error.message : 'Unknown error'
          }
        });
      }
    });

    // Handle preflight OPTIONS requests
    this.app.options('/mcp', (req: Request, res: Response) => {
      res.status(200).end();
    });
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    const port = process.env.HTTP_PORT || 3002;
    
    logger.warn('🚀 Starting HTTP SAP Note MCP Server');
    logger.warn(`📡 Server will be available at: http://localhost:${port}/mcp`);

    // Auto-initialize the server for HTTP mode
    this.isInitialized = true;
    logger.warn('✅ HTTP MCP Server initialized and ready');

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        logger.warn(`🌐 HTTP MCP Server running on port ${port}`);
        logger.warn(`🔗 MCP endpoint: http://localhost:${port}/mcp`);
        logger.warn(`💡 Health check: http://localhost:${port}/health`);
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
   * Handle incoming JSON-RPC message
   */
  private async handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    logger.info(`Handling MCP message: ${message.method} (id: ${message.id})`);

    try {
      switch (message.method) {
        case 'initialize':
          return this.handleInitialize(message);
        case 'notifications/initialized':
          return this.handleInitialized(message);
        case 'tools/list':
          return this.handleToolsList(message);
        case 'tools/call':
          return await this.handleToolsCall(message);
        case 'ping':
          return this.handlePing(message);
        default:
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`
            }
          };
      }
    } catch (error) {
      logger.error('Error handling message:', error);
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  /**
   * Handle initialize request
   */
  private handleInitialize(message: JsonRpcRequest): JsonRpcResponse {
    const params = message.params || {};
    const clientVersion = params.protocolVersion;
    
    logger.warn('🤝 Client connecting...', { version: clientVersion });

    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false
          },
          resources: {
            listChanged: false,
            subscribe: false
          }
        },
        serverInfo: {
          name: 'sap-note-search-mcp',
          version: '0.2.0'
        }
      }
    };
  }

  /**
   * Handle initialized notification
   */
  private handleInitialized(message: JsonRpcRequest): JsonRpcResponse {
    logger.info('Client initialization completed');
    this.isInitialized = true;
    
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {}
    };
  }

  /**
   * Handle tools/list request
   */
  private handleToolsList(message: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'sap_note_search',
            description: 'Search SAP Notes / KB articles by free text or note ID.',
            inputSchema: SAP_NOTE_SEARCH_SCHEMA
          },
          {
            name: 'sap_note_get',
            description: 'Fetch full metadata & HTML for a single Note.',
            inputSchema: SAP_NOTE_GET_SCHEMA
          }
        ]
      }
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.isInitialized) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32002,
          message: 'Server not initialized'
        }
      };
    }

    const params = message.params || {};
    const toolName = params.name;
    const toolArgs = params.arguments || {};

    logger.warn('🔧 Tool call:', { tool: toolName });

    // Ensure authentication with detailed error handling
    logger.warn('🔐 Starting authentication for tool call...');
    let token: string;
    try {
      token = await this.authenticator.ensureAuthenticated();
      logger.warn('✅ Authentication successful for tool call');
    } catch (authError) {
      logger.error('❌ Authentication failed in HTTP context:', authError);
      if (authError instanceof Error) {
        logger.error('Auth error details:', {
          message: authError.message,
          name: authError.name,
          stack: authError.stack?.split('\n').slice(0, 5) // First 5 lines of stack
        });
      }
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: `Authentication failed: ${authError instanceof Error ? authError.message : 'Unknown authentication error'}`
        }
      };
    }

    let result: any;

    try {
      switch (toolName) {
        case 'sap_note_search':
          result = await this.handleSapNoteSearch(toolArgs, token);
          break;
        case 'sap_note_get':
          result = await this.handleSapNoteGet(toolArgs, token);
          break;
        default:
          return {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`
            }
          };
      }

      return {
        jsonrpc: '2.0',
        id: message.id,
        result
      };

    } catch (error) {
      logger.error('Tool call failed:', error);
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      };
    }
  }

  /**
   * Handle SAP Note search
   */
  private async handleSapNoteSearch(args: any, token: string): Promise<any> {
    // Validate input parameters
    if (!validateSearchParams(args)) {
      throw new Error(`Invalid search parameters: ${JSON.stringify(validateSearchParams.errors)}`);
    }

    const searchParams = args as SapNoteSearchParams;
    logger.info(`🔎 [handleSapNoteSearch] Starting search for query: "${searchParams.q}"`);
    
    const searchResponse = await this.sapNotesClient.searchNotes(searchParams.q, token, 10);

    // Format results for MCP
    let resultText = `Found ${searchResponse.totalResults} SAP Note(s) for query: "${searchResponse.query}"\n\n`;
    
    for (const note of searchResponse.results) {
      resultText += `**SAP Note ${note.id}**\n`;
      resultText += `Title: ${note.title}\n`;
      resultText += `Summary: ${note.summary}\n`;
      resultText += `Component: ${note.component || 'Not specified'}\n`;
      resultText += `Release Date: ${note.releaseDate}\n`;
      resultText += `Language: ${note.language}\n`;
      resultText += `URL: ${note.url}\n\n`;
    }

    logger.debug(`📤 [handleSapNoteSearch] Return message preview:\n${resultText.substring(0, 300)}...`);
    logger.info(`✅ [handleSapNoteSearch] Successfully completed search, returning ${searchResponse.totalResults} results`);

    return {
      content: [{
        type: 'text',
        text: resultText
      }],
      isError: false
    };
  }

  /**
   * Handle SAP Note get
   */
  private async handleSapNoteGet(args: any, token: string): Promise<any> {
    // Validate input parameters
    if (!validateGetParams(args)) {
      throw new Error(`Invalid note ID parameters: ${JSON.stringify(validateGetParams.errors)}`);
    }

    const getParams = args as SapNoteGetParams;
    const noteDetail = await this.sapNotesClient.getNote(getParams.id, token);

    if (!noteDetail) {
      return {
        content: [{
          type: 'text',
          text: `SAP Note ${getParams.id} not found or not accessible.`
        }],
        isError: true
      };
    }

    // Format detailed note information
    let resultText = `**SAP Note ${noteDetail.id} - Detailed Information**\n\n`;
    resultText += `**Title:** ${noteDetail.title}\n`;
    resultText += `**Summary:** ${noteDetail.summary}\n`;
    resultText += `**Component:** ${noteDetail.component || 'Not specified'}\n`;
    resultText += `**Priority:** ${noteDetail.priority || 'Not specified'}\n`;
    resultText += `**Category:** ${noteDetail.category || 'Not specified'}\n`;
    resultText += `**Release Date:** ${noteDetail.releaseDate}\n`;
    resultText += `**Language:** ${noteDetail.language}\n`;
    resultText += `**URL:** ${noteDetail.url}\n\n`;
    resultText += `**Content:**\n${noteDetail.content}\n\n`;

    return {
      content: [{
        type: 'text',
        text: resultText
      }],
      isError: false
    };
  }

  /**
   * Handle ping request
   */
  private handlePing(message: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        timestamp: new Date().toISOString(),
        status: 'pong'
      }
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down HTTP MCP server...');
    try {
      await this.stop();
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
  const server = new HttpSapNoteMcpServer();
  
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

export { HttpSapNoteMcpServer };
