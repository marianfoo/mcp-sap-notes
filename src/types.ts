// MCP Tool definitions
export interface ToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
  }>;
  isError?: boolean;
}

export interface SapNoteSearchParams {
  q: string;
  lang?: 'EN' | 'DE';
}

export interface SapNoteGetParams {
  id: string;
  lang?: 'EN' | 'DE';
}

// SAP Note data structures (from SAP Notes API)
export interface SapNote {
  id: string;
  title: string;
  releaseDate: string;
  component?: string;
  priority?: string;
  category?: string;
  language: string;
  summary: string;
  url: string;
}

export interface SapNoteDetail extends SapNote {
  content: string;
}

// Authentication method type
export type AuthMethod = 'certificate' | 'password' | 'auto';

// Configuration and environment
export interface ServerConfig {
  // Certificate auth (optional if using password auth)
  pfxPath: string;
  pfxPassphrase: string;
  // Username/password auth (optional if using certificate auth)
  sapUsername?: string;
  sapPassword?: string;
  // Auth method selection
  authMethod: AuthMethod;
  // MFA/2FA timeout in ms (how long to wait for manual 2FA code entry)
  mfaTimeout: number;
  // General config
  maxJwtAgeH: number;
  headful: boolean;
  logLevel: string;
  // Cache/state sharing
  tokenCacheFile: string;
  ssoStorageStateFile?: string;
  sapLoginUrl: string;
}

// Error types
export interface ApiError {
  error: string;
  message: string;
  code?: string;
  statusCode: number;
}

// MCP Server capabilities
export interface MCPCapabilities {
  tools: {
    search: {
      description: string;
      inputSchema: object;
      examples: Array<SapNoteSearchParams>;
    };
    fetch: {
      description: string;
      inputSchema: object;
      examples: Array<SapNoteGetParams>;
    };
  };
  resources: {
    'note-html': {
      description: string;
      mimeTypes: string[];
    };
  };
}

// JSON Schema definitions for validation
export const SAP_NOTE_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', description: 'Query string or Note ID (e.g. "2744792").' },
    lang: { type: 'string', enum: ['EN', 'DE'], default: 'EN' }
  },
  required: ['q'],
  additionalProperties: false
} as const;

export const SAP_NOTE_GET_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'SAP Note ID', pattern: '^[0-9]{6,8}$' },
    lang: { type: 'string', enum: ['EN', 'DE'], default: 'EN' }
  },
  required: ['id'],
  additionalProperties: false
} as const;
