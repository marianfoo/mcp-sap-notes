import pino from 'pino';

// Create logger with environment-based configuration
const isDevelopment = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || 'info';

// Detect MCP mode: when running via Cursor or other MCP clients
// - Piped input/output (not interactive terminal)
// - No TTY attached to stdout (running as subprocess) 
// - Or explicit MCP environment variable
const isMcpMode = !process.stdin.isTTY || !process.stdout.isTTY || process.env.MCP_MODE === 'true';

// In MCP mode, only show error and warn level logs to stderr for critical events
// This allows authentication progress to be visible while keeping noise low
const effectiveLogLevel = isMcpMode ? 'warn' : logLevel;

// Create a simple stderr logger for MCP mode
const createMcpLogger = () => {
  return {
    warn: (msg: string, obj?: any) => {
      const timestamp = new Date().toISOString().substring(11, 19);
      const message = obj ? `${msg} ${JSON.stringify(obj)}` : msg;
      process.stderr.write(`[${timestamp}] ${message}\n`);
    },
    error: (msg: string, obj?: any) => {
      const timestamp = new Date().toISOString().substring(11, 19);
      const message = obj ? `${msg} ${JSON.stringify(obj)}` : msg;
      process.stderr.write(`[${timestamp}] ERROR: ${message}\n`);
    },
    info: () => {}, // No-op in MCP mode
    debug: () => {} // No-op in MCP mode
  };
};

export const logger = isMcpMode ? createMcpLogger() : pino({
  level: effectiveLogLevel,
  // Use pretty printing only in development
  transport: isDevelopment ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  } : undefined,
  // Base configuration
  base: {
    service: 'sap-note-search-mcp'
  },
  // Timestamp configuration
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact sensitive information
  redact: {
    paths: ['password', 'passphrase', 'token', 'access_token', 'pfxPassphrase'],
    censor: '[REDACTED]'
  }
});

// Export child loggers for different modules
export const authLogger = isMcpMode ? logger : (logger as any).child({ module: 'auth' });
export const apiLogger = isMcpMode ? logger : (logger as any).child({ module: 'api' });
export const serverLogger = isMcpMode ? logger : (logger as any).child({ module: 'server' }); 