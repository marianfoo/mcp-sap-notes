import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
 * SAP Note MCP Server using the MCP SDK (default implementation)
 */
class SapNoteMcpServer {
  private config: ServerConfig;
  private authenticator: SapAuthenticator;
  private sapNotesClient: SapNotesApiClient;
  private mcpServer: McpServer;

  constructor() {
    this.config = this.loadConfig();
    this.authenticator = new SapAuthenticator(this.config);
    this.sapNotesClient = new SapNotesApiClient(this.config);
    
    // Create MCP server with SDK
    this.mcpServer = new McpServer({
      name: 'sap-note-search-mcp',
      version: '0.3.0'
    });

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
   * Setup MCP tools using the SDK
   */
  private setupTools(): void {
    // Tools can be registered here similarly to HTTP server
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    logger.warn('🚀 Starting SAP Note MCP Server');
    
    try {
      // Create stdio transport
      const transport = new StdioServerTransport();
      
      // Connect server to transport
      await this.mcpServer.connect(transport);
      
      logger.warn('✅ MCP Server connected and ready');
      
    } catch (error) {
      logger.error('❌ Failed to start MCP server:', error);
      throw error;
    }
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
  
  // Handle process termination gracefully
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  
  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export { SapNoteMcpServer };