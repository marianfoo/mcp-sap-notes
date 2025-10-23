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
import {
  NoteSearchInputSchema,
  NoteSearchOutputSchema,
  NoteGetInputSchema,
  NoteGetOutputSchema,
  SAP_NOTE_SEARCH_DESCRIPTION,
  SAP_NOTE_GET_DESCRIPTION
} from './schemas/sap-notes.js';

// Get the directory of this module for resolving paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the project root
config({ path: join(__dirname, '..', '.env') });

/**
 * SAP Note MCP Server using the MCP SDK
 * This implementation uses enhanced tool descriptions for improved LLM accuracy
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
    
    // Create MCP server with official SDK
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
   * Setup MCP tools using the official SDK
   */
  private setupTools(): void {
    // SAP Note Search Tool
    this.mcpServer.registerTool(
      'sap_note_search',
      {
        title: 'Search SAP Notes',
        description: SAP_NOTE_SEARCH_DESCRIPTION,
        inputSchema: NoteSearchInputSchema,
        outputSchema: NoteSearchOutputSchema
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
        description: SAP_NOTE_GET_DESCRIPTION,
        inputSchema: NoteGetInputSchema,
        outputSchema: NoteGetOutputSchema
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

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down MCP server...');
    try {
      await this.authenticator.destroy();
      logger.info('Server shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }
}

// Start server if this file is run directly (ESM-safe, cross-platform)
const isDirectRun = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const invoked = process.argv[1] ? process.argv[1] : '';
    return thisFile === invoked;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const server = new SapNoteMcpServer();
  
  // Handle process termination gracefully
  process.on('SIGINT', () => server.shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => server.shutdown().then(() => process.exit(0)));
  
  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

export { SapNoteMcpServer };







