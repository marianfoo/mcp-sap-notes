import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get the directory of this module for resolving paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the project root  
config({ path: join(__dirname, '..', '.env') });

// Import our authentication class
import { SapAuthenticator } from '../dist/auth.js';

async function testAuthentication() {
  console.log('🧪 Testing SAP Authentication...\n');

  // Enhanced environment debugging
  console.log('🔍 DETAILED ENVIRONMENT DEBUGGING:\n');
  
  // System information
  console.log('📊 System Information:');
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Architecture: ${process.arch}`);
  console.log(`   Node.js Version: ${process.version}`);
  console.log(`   Working Directory: ${process.cwd()}`);
  console.log(`   User: ${process.env.USER || process.env.USERNAME || 'unknown'}`);
  console.log(`   Home: ${process.env.HOME || process.env.USERPROFILE || 'unknown'}`);
  
  // Docker detection
  const fs = await import('fs');
  const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/proc/self/cgroup');
  console.log(`   Running in Docker: ${isDocker}`);
  console.log('');

  // Playwright environment variables
  console.log('🎭 Playwright Environment:');
  const playwrightEnvVars = [
    'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    'PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH',
    'PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH',
    'PLAYWRIGHT_BROWSER_TYPE'
  ];
  
  playwrightEnvVars.forEach(envVar => {
    const value = process.env[envVar];
    console.log(`   ${envVar}: ${value || 'NOT_SET'}`);
  });
  console.log('');

  // Browser executable detection
  console.log('🔍 Browser Executable Detection:');
  const commonBrowserPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/firefox'
  ];
  
  commonBrowserPaths.forEach(path => {
    const exists = fs.existsSync(path);
    console.log(`   ${path}: ${exists ? 'EXISTS' : 'NOT_FOUND'}`);
  });
  console.log('');

  // Playwright cache directory
  const playwrightCache = process.env.PLAYWRIGHT_BROWSERS_PATH || 
                         `${process.env.HOME || '/root'}/.cache/ms-playwright`;
  console.log('📂 Playwright Cache Directory:');
  console.log(`   Path: ${playwrightCache}`);
  
  if (fs.existsSync(playwrightCache)) {
    try {
      const contents = fs.readdirSync(playwrightCache);
      console.log(`   Contents: ${contents.length > 0 ? contents.join(', ') : 'EMPTY'}`);
      
      // Show detailed browser directories
      contents.forEach(item => {
        const itemPath = `${playwrightCache}/${item}`;
        if (fs.statSync(itemPath).isDirectory()) {
          const subContents = fs.readdirSync(itemPath);
          console.log(`     ${item}/: ${subContents.join(', ')}`);
        }
      });
    } catch (e) {
      console.log(`   Error reading cache: ${e.message}`);
    }
  } else {
    console.log('   Status: DOES NOT EXIST');
  }
  console.log('');

  // Load configuration
  const requiredEnvVars = ['PFX_PATH', 'PFX_PASSPHRASE'];
  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    console.log('\n📋 Setup checklist:');
    console.log('1. Copy env.example to .env');
    console.log('2. Place your SAP certificate in certs/sap.pfx'); 
    console.log('3. Set PFX_PASSPHRASE in .env file');
    process.exit(1);
  }

  const config = {
    port: parseInt(process.env.PORT || '3000'),
    pfxPath: process.env.PFX_PATH,
    pfxPassphrase: process.env.PFX_PASSPHRASE,
    coveoOrg: process.env.COVEO_ORG || 'sapamericaproductiontyfzmfz0',
    coveoHost: process.env.COVEO_HOST || 'platform.cloud.coveo.com',
    maxJwtAgeH: parseInt(process.env.MAX_JWT_AGE_H || '12'),
    headful: process.env.HEADFUL === 'true',
    logLevel: process.env.LOG_LEVEL || 'info'
  };

  console.log('📋 Configuration:');
  console.log(`   PFX Path: ${config.pfxPath}`);
  console.log(`   Coveo Org: ${config.coveoOrg}`);
  console.log(`   Coveo Host: ${config.coveoHost}`);
  console.log(`   Max JWT Age: ${config.maxJwtAgeH}h`);
  console.log(`   Headful Mode: ${config.headful}`);
  console.log('');

  // Enhanced certificate validation
  console.log('🔐 Certificate Validation:');
  console.log(`   Checking path: ${config.pfxPath}`);
  
  if (!fs.existsSync(config.pfxPath)) {
    console.error(`❌ Certificate file not found: ${config.pfxPath}`);
    console.log('\n📋 Please ensure:');
    console.log('1. Your SAP Passport certificate is placed at the specified path');
    console.log('2. The file has .pfx extension');
    console.log('3. The path in .env is correct');
    
    // List contents of certificate directory for debugging
    const certDir = config.pfxPath.substring(0, config.pfxPath.lastIndexOf('/'));
    if (fs.existsSync(certDir)) {
      console.log(`\n🔍 Contents of ${certDir}:`);
      try {
        const certDirContents = fs.readdirSync(certDir);
        certDirContents.forEach(file => {
          console.log(`   ${file}`);
        });
      } catch (e) {
        console.log(`   Error listing directory: ${e.message}`);
      }
    }
    
    process.exit(1);
  }

  // Check certificate file size and permissions
  try {
    const certStat = fs.statSync(config.pfxPath);
    console.log(`   File size: ${certStat.size} bytes`);
    console.log(`   File permissions: ${(certStat.mode & parseInt('777', 8)).toString(8)}`);
    console.log(`   File modified: ${certStat.mtime.toISOString()}`);
    
    if (certStat.size === 0) {
      console.error('❌ Certificate file is empty');
      process.exit(1);
    } else if (certStat.size < 100) {
      console.warn('⚠️ Certificate file seems very small, please verify it is correct');
    }
    
    console.log('✅ Certificate file found and validated');
  } catch (e) {
    console.error(`❌ Error accessing certificate file: ${e.message}`);
    process.exit(1);
  }
  console.log('');

  const authenticator = new SapAuthenticator(config);

  try {
    console.log('🔐 Starting authentication test...');
    console.log('');
    
    // Attempt authentication
    const token = await authenticator.ensureAuthenticated();
    
    console.log('');
    console.log('🎉 Authentication successful!');
    console.log(`   Token length: ${token.length} characters`);
    console.log(`   Token preview: ${token.substring(0, 50)}...`);
    console.log('');
    
    // Test if we can reuse the cached token
    console.log('🔄 Testing token cache...');
    const startTime = Date.now();
    const cachedToken = await authenticator.ensureAuthenticated();
    const duration = Date.now() - startTime;
    
    if (token === cachedToken && duration < 1000) {
      console.log(`✅ Token cache working (${duration}ms)`);
    } else {
      console.log(`⚠️ Token cache may not be working properly`);
    }
    
    console.log('');
    console.log('🎯 Authentication test completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log('1. Your authentication is working correctly');
    console.log('2. The MCP server should now work in Cursor');
    console.log('3. Try using the sap_note_search or sap_note_get tools');
    
  } catch (error) {
    console.error('');
    console.error('❌ Authentication failed:');
    console.error(`   Error type: ${error.name || 'Unknown'}`);
    console.error(`   Error message: ${error.message}`);
    
    // Show stack trace for detailed debugging
    if (error.stack) {
      console.error('');
      console.error('📋 Full Stack Trace:');
      console.error(error.stack);
    }
    
    // Show additional error properties
    if (error.code) console.error(`   Error code: ${error.code}`);
    if (error.errno) console.error(`   Error number: ${error.errno}`);
    if (error.syscall) console.error(`   System call: ${error.syscall}`);
    if (error.path) console.error(`   Path: ${error.path}`);
    
    console.error('');
    
    // Enhanced troubleshooting based on error patterns
    if (error.message.includes('Certificate') || error.message.includes('PFX')) {
      console.log('🔍 Certificate troubleshooting:');
      console.log('1. Verify the certificate file is valid and not corrupted');
      console.log('2. Check the passphrase is correct');
      console.log('3. Ensure the certificate has access to SAP systems');
      console.log('4. Try regenerating the certificate from SAP Support Portal');
      console.log('5. Verify certificate is not expired');
    } else if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      console.log('🔍 Timeout troubleshooting:');
      console.log('1. Check your internet connection');
      console.log('2. Verify SAP services are accessible');
      console.log('3. Try setting HEADFUL=true to see browser interaction');
      console.log('4. Increase timeout values if on slow connection');
      console.log('5. Check if corporate firewall is blocking access');
    } else if (error.message.includes('Executable doesn\'t exist') || 
               error.message.includes('ENOENT') ||
               error.message.includes('No such file or directory')) {
      console.log('🔍 Browser executable troubleshooting:');
      console.log('1. Install Playwright browsers: npx playwright install');
      console.log('2. For Docker/Alpine: apk add chromium nss freetype harfbuzz');
      console.log('3. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to system browser');
      console.log('4. Check browser installation: which chromium');
      console.log('5. Verify file permissions on browser executable');
    } else if (error.message.includes('pthread_create') || 
               error.message.includes('Resource temporarily unavailable')) {
      console.log('🔍 Resource exhaustion troubleshooting:');
      console.log('1. Increase Docker container memory limits');
      console.log('2. Reduce concurrent processes');
      console.log('3. Try running with fewer browser instances');
      console.log('4. Check available system memory');
      console.log('5. Restart Docker container to free resources');
    } else if (error.message.includes('error while loading shared libraries')) {
      console.log('🔍 Shared library troubleshooting (Alpine Linux):');
      console.log('1. Install missing dependencies: apk add nss freetype harfbuzz');
      console.log('2. Install additional libs: apk add libstdc++ glib libx11');
      console.log('3. Check system package manager: apk update && apk upgrade');
      const libMatches = error.message.match(/lib\w+\.so[\.\d]*/g);
      if (libMatches) {
        console.log(`4. Missing libraries detected: ${libMatches.join(', ')}`);
        console.log(`5. Try: apk add ${libMatches.join(' ')}`);
      }
    } else if (error.message.includes('EACCES') || error.message.includes('Permission denied')) {
      console.log('🔍 Permission troubleshooting:');
      console.log('1. Check file permissions on browser executable');
      console.log('2. Try running as different user (non-root might be needed)');
      console.log('3. Check Docker container security settings');
      console.log('4. Verify certificate file permissions');
      console.log('5. Check SELinux/AppArmor restrictions');
    } else {
      console.log('🔍 General troubleshooting:');
      console.log('1. Check the full error details above');
      console.log('2. Verify all environment variables are correct');
      console.log('3. Try setting HEADFUL=true for visual debugging');
      console.log('4. Check if running in supported environment');
      console.log('5. Try running outside Docker first to isolate issues');
    }
    
    // Docker-specific guidance
    if (isDocker) {
      console.log('');
      console.log('🐳 Docker-specific guidance:');
      console.log('1. Ensure container has enough memory (recommend 2GB+)');
      console.log('2. Mount /dev/shm with adequate size for browser');
      console.log('3. Install browser dependencies in Dockerfile');
      console.log('4. Consider using --privileged flag for debugging');
      console.log('5. Check container logs: docker logs <container_id>');
    }
    
    // Environment-specific recommendations
    console.log('');
    console.log('💡 Quick fixes to try:');
    console.log('1. Set HEADFUL=true in .env file');
    console.log('2. Run: npx playwright install chromium');
    console.log('3. Check .env file exists and has correct values');
    console.log('4. Verify certificate path is absolute and correct');
    console.log('5. Try test on host system first (outside Docker)');
    
    process.exit(1);
  } finally {
    await authenticator.destroy();
  }
}

// Run the test
testAuthentication().catch(error => {
  console.error('Test script failed:', error);
  process.exit(1);
}); 