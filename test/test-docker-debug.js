#!/usr/bin/env node
/**
 * Docker Playwright Debugging Script
 * 
 * This script performs comprehensive debugging of Playwright and browser issues
 * specifically designed for Docker container environments.
 */

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';

// Get the directory of this module for resolving paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from the project root  
config({ path: join(__dirname, '..', '.env') });

async function dockerDebugTest() {
  console.log('🐳 DOCKER PLAYWRIGHT DEBUGGING SCRIPT');
  console.log('=====================================\n');

  const fs = await import('fs');
  const { execSync } = await import('child_process');

  // 1. Environment Analysis
  console.log('🔍 ENVIRONMENT ANALYSIS:');
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Architecture: ${process.arch}`);
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Working Directory: ${process.cwd()}`);
  console.log(`   User: ${process.env.USER || process.env.USERNAME || 'unknown'}`);
  console.log(`   Home: ${process.env.HOME || process.env.USERPROFILE || 'unknown'}`);
  
  // Docker detection
  const isDocker = fs.existsSync('/.dockerenv') || fs.existsSync('/proc/self/cgroup');
  console.log(`   Docker Container: ${isDocker ? 'YES' : 'NO'}`);
  
  if (isDocker) {
    try {
      const cgroupContent = fs.readFileSync('/proc/self/cgroup', 'utf8');
      if (cgroupContent.includes('docker')) {
        console.log('   Container Type: Docker');
      } else if (cgroupContent.includes('kubepods')) {
        console.log('   Container Type: Kubernetes');
      } else {
        console.log('   Container Type: Other');
      }
    } catch (e) {
      console.log('   Container Type: Unknown');
    }
  }
  console.log('');

  // 2. System Information
  console.log('💻 SYSTEM INFORMATION:');
  try {
    const memInfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const memTotal = memInfo.match(/MemTotal:\s+(\d+)\s+kB/);
    const memAvailable = memInfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    
    if (memTotal) {
      console.log(`   Total Memory: ${Math.round(parseInt(memTotal[1]) / 1024)} MB`);
    }
    if (memAvailable) {
      console.log(`   Available Memory: ${Math.round(parseInt(memAvailable[1]) / 1024)} MB`);
    }
  } catch (e) {
    console.log('   Memory info: Unable to read');
  }

  try {
    const loadavg = fs.readFileSync('/proc/loadavg', 'utf8').trim();
    console.log(`   Load Average: ${loadavg}`);
  } catch (e) {
    console.log('   Load Average: Unable to read');
  }

  try {
    const uptime = fs.readFileSync('/proc/uptime', 'utf8').trim().split(' ')[0];
    console.log(`   Uptime: ${Math.round(parseFloat(uptime) / 60)} minutes`);
  } catch (e) {
    console.log('   Uptime: Unable to read');
  }
  console.log('');

  // 3. Package Manager Detection
  console.log('📦 PACKAGE MANAGER:');
  const packageManagers = [
    { cmd: 'apk --version', name: 'Alpine APK' },
    { cmd: 'apt --version', name: 'Debian APT' },
    { cmd: 'yum --version', name: 'RedHat YUM' },
    { cmd: 'dnf --version', name: 'Fedora DNF' }
  ];

  for (const pm of packageManagers) {
    try {
      const output = execSync(pm.cmd, { encoding: 'utf8', stdio: 'pipe' });
      console.log(`   ${pm.name}: Available`);
      console.log(`   Version: ${output.split('\n')[0]}`);
      break;
    } catch (e) {
      // Continue to next package manager
    }
  }
  console.log('');

  // 4. Browser Dependencies Check
  console.log('🌐 BROWSER DEPENDENCIES:');
  const criticalLibs = [
    '/lib/libc.so.6',
    '/lib/ld-linux-x86-64.so.2',
    '/usr/lib/libnss3.so',
    '/usr/lib/libglib-2.0.so.0',
    '/usr/lib/libx11.so.6',
    '/usr/lib/libxcb.so.1',
    '/usr/lib/libxcomposite.so.1',
    '/usr/lib/libxdamage.so.1',
    '/usr/lib/libxext.so.6',
    '/usr/lib/libxfixes.so.3',
    '/usr/lib/libxi.so.6',
    '/usr/lib/libxrandr.so.2',
    '/usr/lib/libxrender.so.1',
    '/usr/lib/libxss.so.1',
    '/usr/lib/libxtst.so.6',
    '/usr/lib/libasound.so.2',
    '/usr/lib/libatspi.so.0',
    '/usr/lib/libdrm.so.2',
    '/usr/lib/libgtk-3.so.0',
    '/usr/lib/libgdk-3.so.0'
  ];

  let missingLibs = [];
  criticalLibs.forEach(lib => {
    const exists = fs.existsSync(lib);
    if (!exists) {
      // Try alternative paths
      const altPaths = [
        lib.replace('/usr/lib/', '/usr/lib/x86_64-linux-gnu/'),
        lib.replace('/usr/lib/', '/lib/x86_64-linux-gnu/'),
        lib.replace('/usr/lib/', '/usr/local/lib/'),
        lib.replace('/lib/', '/usr/lib/')
      ];
      
      let found = false;
      for (const altPath of altPaths) {
        if (fs.existsSync(altPath)) {
          console.log(`   ${lib}: FOUND (${altPath})`);
          found = true;
          break;
        }
      }
      
      if (!found) {
        console.log(`   ${lib}: MISSING`);
        missingLibs.push(lib);
      }
    } else {
      console.log(`   ${lib}: EXISTS`);
    }
  });

  if (missingLibs.length > 0) {
    console.log(`\n   ⚠️  Missing ${missingLibs.length} critical libraries`);
    console.log('   💡 Alpine: apk add nss freetype harfbuzz ca-certificates fonts-noto');
    console.log('   💡 Debian: apt-get install libnss3 libatk-bridge2.0-0 libcups2');
  }
  console.log('');

  // 5. Browser Executables Check
  console.log('🔍 BROWSER EXECUTABLES:');
  const browserPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/firefox',
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome',
    '/usr/local/bin/chromium'
  ];

  let foundBrowsers = [];
  browserPaths.forEach(path => {
    if (fs.existsSync(path)) {
      try {
        const stat = fs.statSync(path);
        const permissions = (stat.mode & parseInt('777', 8)).toString(8);
        const size = Math.round(stat.size / 1024 / 1024);
        console.log(`   ${path}: EXISTS (${size}MB, ${permissions})`);
        foundBrowsers.push(path);
        
        // Try to get version
        try {
          const version = execSync(`${path} --version 2>/dev/null || echo "Version unavailable"`, 
                                  { encoding: 'utf8', timeout: 5000 }).trim();
          console.log(`     Version: ${version}`);
        } catch (e) {
          console.log(`     Version: Unable to determine`);
        }
      } catch (e) {
        console.log(`   ${path}: ERROR (${e.message})`);
      }
    } else {
      console.log(`   ${path}: NOT_FOUND`);
    }
  });
  console.log('');

  // 6. Playwright Environment
  console.log('🎭 PLAYWRIGHT ENVIRONMENT:');
  const playwrightEnvs = [
    'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
    'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    'PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH',
    'PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH'
  ];

  playwrightEnvs.forEach(env => {
    const value = process.env[env];
    console.log(`   ${env}: ${value || 'NOT_SET'}`);
  });
  console.log('');

  // 7. Playwright Cache Directory
  console.log('📂 PLAYWRIGHT CACHE:');
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH || 
                   `${process.env.HOME || '/root'}/.cache/ms-playwright`;
  console.log(`   Cache Directory: ${cacheDir}`);
  
  if (fs.existsSync(cacheDir)) {
    try {
      const contents = fs.readdirSync(cacheDir);
      console.log(`   Contents (${contents.length} items):`);
      
      contents.forEach(item => {
        const itemPath = join(cacheDir, item);
        const stat = fs.statSync(itemPath);
        const size = stat.isDirectory() ? 'DIR' : `${Math.round(stat.size / 1024 / 1024)}MB`;
        console.log(`     ${item}: ${size}`);
        
        if (stat.isDirectory()) {
          try {
            const subContents = fs.readdirSync(itemPath);
            console.log(`       Contains: ${subContents.join(', ')}`);
          } catch (e) {
            console.log(`       Contents: Unable to read`);
          }
        }
      });
    } catch (e) {
      console.log(`   Error reading cache: ${e.message}`);
    }
  } else {
    console.log('   Status: DOES NOT EXIST');
  }
  console.log('');

  // 8. Playwright Browser Test
  console.log('🧪 PLAYWRIGHT BROWSER TEST:');
  
  try {
    console.log('   Testing chromium.executablePath()...');
    const execPath = await chromium.executablePath();
    console.log(`   Executable Path: ${execPath}`);
    
    // Check if executable exists and is accessible
    if (fs.existsSync(execPath)) {
      const stat = fs.statSync(execPath);
      const permissions = (stat.mode & parseInt('777', 8)).toString(8);
      console.log(`   Executable Status: EXISTS (${permissions})`);
      
      // Try to launch browser
      console.log('   Testing browser launch...');
      const browser = await chromium.launch({ 
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor'
        ]
      });
      
      console.log('   ✅ Browser launched successfully!');
      
      // Test creating a page
      const context = await browser.newContext();
      const page = await context.newPage();
      
      console.log('   ✅ Page created successfully!');
      
      // Test navigation
      await page.goto('data:text/html,<h1>Test</h1>');
      const title = await page.title();
      
      console.log(`   ✅ Navigation successful! Title: "${title}"`);
      
      await browser.close();
      console.log('   ✅ Browser closed successfully!');
      
    } else {
      console.log(`   ❌ Executable not found: ${execPath}`);
    }
    
  } catch (error) {
    console.log('   ❌ Browser test failed:');
    console.log(`     Error: ${error.message}`);
    
    if (error.stack) {
      console.log('     Stack trace:');
      console.log(error.stack.split('\n').map(line => `       ${line}`).join('\n'));
    }
  }
  console.log('');

  // 9. Certificate Check (if configured)
  if (process.env.PFX_PATH) {
    console.log('🔐 CERTIFICATE CHECK:');
    console.log(`   PFX Path: ${process.env.PFX_PATH}`);
    
    if (fs.existsSync(process.env.PFX_PATH)) {
      const stat = fs.statSync(process.env.PFX_PATH);
      const permissions = (stat.mode & parseInt('777', 8)).toString(8);
      console.log(`   Certificate: EXISTS (${stat.size} bytes, ${permissions})`);
      console.log(`   Modified: ${stat.mtime.toISOString()}`);
    } else {
      console.log('   Certificate: NOT_FOUND');
    }
    console.log('');
  }

  // 10. Recommendations
  console.log('💡 RECOMMENDATIONS:');
  
  if (missingLibs.length > 0) {
    console.log('   🔧 Install missing browser dependencies');
  }
  
  if (foundBrowsers.length === 0) {
    console.log('   🔧 Install a system browser (chromium recommended)');
  }
  
  const cacheExists = fs.existsSync(cacheDir);
  if (!cacheExists) {
    console.log('   🔧 Install Playwright browsers: npx playwright install');
  }
  
  if (isDocker) {
    console.log('   🐳 Docker-specific:');
    console.log('     - Ensure adequate memory (2GB+ recommended)');
    console.log('     - Mount /dev/shm with sufficient size');
    console.log('     - Consider --privileged flag for debugging');
  }
  
  console.log('\n🎯 DEBUG COMPLETE!\n');
}

// Run the debug test
dockerDebugTest().catch(error => {
  console.error('❌ Debug script failed:', error);
  process.exit(1);
});
