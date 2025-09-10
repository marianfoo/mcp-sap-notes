import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
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

class SapNoteMcpServer {
  private config: ServerConfig;
  private authenticator: SapAuthenticator;
  private sapNotesClient: SapNotesApiClient;
  private isInitialized = false;

  constructor() {
    this.config = this.loadConfig();
    this.authenticator = new SapAuthenticator(this.config);
    this.sapNotesClient = new SapNotesApiClient(this.config);
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
   * Start the MCP server
   */
  async start(): Promise<void> {
    // Debug info for troubleshooting (only to stderr)
    if (process.env.DEBUG) {
      process.stderr.write(`DEBUG: TTY check - isTTY: ${process.stdout.isTTY}\n`);
      process.stderr.write(`DEBUG: MCP_MODE: ${process.env.MCP_MODE}\n`);
    }
    
    logger.warn('🚀 Starting SAP Note MCP Server');

    // Set up stdin/stdout communication
    process.stdin.setEncoding('utf8');
    
    let buffer = '';
    
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      
      // Process complete lines (messages)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          this.handleMessage(line.trim());
        }
      }
    });

    process.stdin.on('end', () => {
      logger.info('MCP Server shutting down');
      process.exit(0);
    });

    // Handle process termination gracefully
    process.on('SIGINT', this.shutdown.bind(this));
    process.on('SIGTERM', this.shutdown.bind(this));
  }

  /**
   * Handle incoming JSON-RPC message
   */
  private async handleMessage(messageStr: string): Promise<void> {
    try {
      const message = JSON.parse(messageStr) as JsonRpcRequest;
      
      // Removed debug logging to prevent stdout pollution in MCP mode

      switch (message.method) {
        case 'initialize':
          await this.handleInitialize(message);
          break;
        case 'notifications/initialized':
          this.handleInitialized();
          break;
        case 'tools/list':
          await this.handleToolsList(message);
          break;
        case 'tools/call':
          await this.handleToolsCall(message);
          break;
        case 'ping':
          this.handlePing(message);
          break;
        default:
          this.sendError(message.id, -32601, `Method not found: ${message.method}`);
      }
    } catch (error) {
      logger.error('Error handling message:', error);
      this.sendError(undefined, -32700, 'Parse error');
    }
  }

  /**
   * Handle initialize request
   */
  private async handleInitialize(message: JsonRpcRequest): Promise<void> {
    const params = message.params || {};
    const clientVersion = params.protocolVersion;
    
    logger.warn('🤝 Client connecting...', { version: clientVersion });

    const response: JsonRpcResponse = {
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

    this.sendMessage(response);
  }

  /**
   * Handle initialized notification
   */
  private handleInitialized(): void {
    logger.info('Client initialization completed');
    this.isInitialized = true;
  }

  /**
   * Handle tools/list request
   */
  private async handleToolsList(message: JsonRpcRequest): Promise<void> {
    const response: JsonRpcResponse = {
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

    this.sendMessage(response);
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(message: JsonRpcRequest): Promise<void> {
    try {
      if (!this.isInitialized) {
        this.sendError(message.id, -32002, 'Server not initialized');
        return;
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
        logger.error('❌ Authentication failed in MCP context:', authError);
        if (authError instanceof Error) {
          logger.error('Auth error details:', {
            message: authError.message,
            name: authError.name,
            stack: authError.stack?.split('\n').slice(0, 5) // First 5 lines of stack
          });
        }
        this.sendError(message.id, -32603, `Authentication failed: ${authError instanceof Error ? authError.message : 'Unknown authentication error'}`);
        return;
      }

      let result: any;

      switch (toolName) {
        case 'sap_note_search':
          result = await this.handleSapNoteSearch(toolArgs, token);
          break;
        case 'sap_note_get':
          result = await this.handleSapNoteGet(toolArgs, token);
          break;
        default:
          this.sendError(message.id, -32601, `Unknown tool: ${toolName}`);
          return;
      }

      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: message.id,
        result
      };

      this.sendMessage(response);

    } catch (error) {
      logger.error('Tool call failed:', error);
      this.sendError(message.id, -32603, `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  private handlePing(message: JsonRpcRequest): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: message.id,
      result: {}
    };

    this.sendMessage(response);
  }

  /**
   * Send JSON-RPC response or notification
   */
  private sendMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    const messageStr = JSON.stringify(message);
    process.stdout.write(messageStr + '\n');
    // Removed debug logging to prevent stdout pollution in MCP mode
  }

  /**
   * Send JSON-RPC error response
   */
  private sendError(id: string | number | undefined, code: number, message: string, data?: any): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data
      }
    };

    this.sendMessage(response);
  }

  /**
   * Graceful shutdown
   */
  private async shutdown(): Promise<void> {
    logger.info('Shutting down MCP server...');
    try {
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
    return thisFile === invoked;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const server = new SapNoteMcpServer();
  
  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export { SapNoteMcpServer }; 