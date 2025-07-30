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

  // Check if certificate file exists
  const fs = await import('fs');
  if (!fs.existsSync(config.pfxPath)) {
    console.error(`❌ Certificate file not found: ${config.pfxPath}`);
    console.log('\n📋 Please ensure:');
    console.log('1. Your SAP Passport certificate is placed at the specified path');
    console.log('2. The file has .pfx extension');
    console.log('3. The path in .env is correct');
    process.exit(1);
  }

  console.log('✅ Certificate file found');
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
    console.error(error.message);
    console.error('');
    
    if (error.message.includes('Certificate')) {
      console.log('🔍 Certificate troubleshooting:');
      console.log('1. Verify the certificate file is valid');
      console.log('2. Check the passphrase is correct');
      console.log('3. Ensure the certificate has access to SAP systems');
    } else if (error.message.includes('timeout')) {
      console.log('🔍 Timeout troubleshooting:');
      console.log('1. Check your internet connection');
      console.log('2. Verify SAP services are accessible');
      console.log('3. Try setting HEADFUL=true to see browser interaction');
    } else {
      console.log('🔍 General troubleshooting:');
      console.log('1. Check the error message above for specific details');
      console.log('2. Verify all environment variables are correct');
      console.log('3. Try setting HEADFUL=true for visual debugging');
    }
    
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