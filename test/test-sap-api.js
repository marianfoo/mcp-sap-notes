import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, '..', '.env') });

console.log('🧪 Testing SAP Notes API with cached token...\n');

// Read cached token
const tokenCacheFile = join(__dirname, '..', 'token-cache.json');
if (!existsSync(tokenCacheFile)) {
  console.error('❌ No cached token found. Run authentication first with: npm run test-auth');
  process.exit(1);
}

const tokenCache = JSON.parse(readFileSync(tokenCacheFile, 'utf8'));
const token = tokenCache.access_token;

console.log('📋 Using cached authentication token');
console.log(`   Token length: ${token.length} characters\n`);

// Import and test the SAP Notes API
const { SapNotesApiClient } = await import('../dist/sap-notes-api.js');

const projectRoot = join(__dirname, '..');
const config_obj = {
  pfxPath: process.env.PFX_PATH || '',
  pfxPassphrase: process.env.PFX_PASSPHRASE || '',
  sapUsername: process.env.SAP_USERNAME,
  sapPassword: process.env.SAP_PASSWORD,
  authMethod: process.env.AUTH_METHOD || 'auto',
  mfaTimeout: parseInt(process.env.MFA_TIMEOUT || '120000'),
  maxJwtAgeH: parseInt(process.env.MAX_JWT_AGE_H || '12'),
  headful: process.env.HEADFUL === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',
  tokenCacheFile: process.env.SAP_NOTES_TOKEN_CACHE_FILE ||
    process.env.TOKEN_CACHE_FILE ||
    join(projectRoot, 'token-cache.json'),
  ssoStorageStateFile: process.env.SAP_SSO_STORAGE_STATE ||
    join(process.env.HOME || process.cwd(), '.sap-mcp', 'sso-storage-state.json'),
};

const sapNotesClient = new SapNotesApiClient(config_obj);

try {
  console.log('🔍 Testing SAP Notes search...');
  
  // Test search
  const searchResult = await sapNotesClient.searchNotes('2744792', token, 5);
  
  console.log(`✅ Search completed!`);
  console.log(`   Query: "${searchResult.query}"`);
  console.log(`   Total results: ${searchResult.totalResults}`);
  console.log(`   Results returned: ${searchResult.results.length}\n`);
  
  if (searchResult.results.length > 0) {
    console.log('📄 First result:');
    const firstResult = searchResult.results[0];
    console.log(`   ID: ${firstResult.id}`);
    console.log(`   Title: ${firstResult.title}`);
    console.log(`   Summary: ${firstResult.summary.substring(0, 100)}...`);
    console.log(`   URL: ${firstResult.url}\n`);
    
    // Test get note details
    console.log(`🔍 Testing get note details for ${firstResult.id}...`);
    const noteDetail = await sapNotesClient.getNote(firstResult.id, token);
    
    if (noteDetail) {
      console.log(`✅ Note details retrieved!`);
      console.log(`   ID: ${noteDetail.id}`);
      console.log(`   Title: ${noteDetail.title}`);
      console.log(`   Content preview: ${noteDetail.content.substring(0, 150)}...`);
    } else {
      console.log(`❌ Could not retrieve note details for ${firstResult.id}`);
    }
  } else {
    console.log('ℹ️ No results found. Trying a different search...');
    
    // Try a keyword search
    const keywordResult = await sapNotesClient.searchNotes('ABAP', token, 3);
    console.log(`   Keyword search results: ${keywordResult.totalResults}`);
  }
  
  // Test health check
  console.log('\n🏥 Testing health check...');
  const healthOk = await sapNotesClient.healthCheck(token);
  console.log(`   Health check: ${healthOk ? '✅ OK' : '❌ Failed'}`);
  
  console.log('\n🎉 SAP Notes API test completed successfully!');
  console.log('\n💡 Next steps:');
  console.log('   1. The new SAP Notes API is working');
  console.log('   2. Try it in Cursor - the MCP server should now work');
  console.log('   3. Use search and fetch tools');

} catch (error) {
  console.error('\n❌ SAP Notes API test failed:', error.message);
  console.error('\n🔧 This might indicate:');
  console.error('   - Authentication token expired');
  console.error('   - SAP endpoint access issues');
  console.error('   - Network connectivity problems');
} 