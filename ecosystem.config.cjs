// PM2 config using npm script directly
// The serve:http script automatically sets AUTO_START=true
module.exports = {
  apps: [{
    name: 'mcp-sap-notes',
    script: 'dist/http-mcp-server.js',
    cwd: '/root/mcp-sap-notes',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      HTTP_PORT: 3123,
      LOG_LEVEL: 'debug',
      AUTO_START: 'true'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // Restart strategy
    exp_backoff_restart_delay: 100,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};

