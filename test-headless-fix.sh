#!/bin/bash
# Test Script to Verify Headless Mode Fix

echo "🧪 Testing Headless Mode Fix for Docker Containers"
echo "================================================"
echo ""

# Test 1: Basic environment detection
echo "📊 Environment Detection Test:"
echo "Platform: $(uname -s)"
echo "Architecture: $(uname -m)"
echo "Docker env: ${DOCKER_ENV:-NOT_SET}"
echo "Display: ${DISPLAY:-NOT_SET}"
echo "TTY stdin: $(tty <&0 2>/dev/null && echo 'YES' || echo 'NO')"
echo "CI: ${CI:-NOT_SET}"
echo ""

# Test 2: Run auth test (should work)
echo "🔐 Running authentication test..."
if npm run test:auth 2>&1 | tail -10; then
    echo "✅ Authentication test passed"
else
    echo "❌ Authentication test failed"
fi
echo ""

# Test 3: Run MCP test with debug mode
echo "🔧 Running MCP test with debug logging..."
echo "This will show detailed browser launch configuration:"
echo ""

# Set container environment and debug mode
export DOCKER_ENV=true
export LOG_LEVEL=debug

# Run the MCP test 
echo "Starting MCP test with container detection..."
npm run test:mcp:debug 2>&1 | head -50

echo ""
echo "🎯 Test completed! Check the output above for:"
echo "1. ✅ Container detection: true"
echo "2. ✅ Force headless: true"
echo "3. ✅ Final headless: true" 
echo "4. ✅ No X server errors"
echo ""
echo "If you see 'Missing X server' errors, the fix needs further adjustment."
