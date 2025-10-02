#!/bin/bash

# Safest way to start debug - avoids race conditions
# This script aggressively cleans and uses longer waits

set -e

echo "🛡️  SAFE DEBUG START 🛡️"
echo ""

# Step 1: Nuclear cleanup
echo "1️⃣ Aggressive cleanup..."
pkill -9 -f "http-mcp-server.js" 2>/dev/null && echo "   ✓ Killed server processes" || echo "   ✓ No server processes"
pm2 stop mcp-sap-notes 2>/dev/null && echo "   ✓ Stopped PM2" || echo "   ✓ No PM2 process"

# Step 2: Wait and verify multiple times
echo "2️⃣ Waiting for port 3123 to be completely free..."
for i in {1..15}; do
    if ! lsof -ti :3123 &>/dev/null; then
        echo "   ✅ Port 3123 is free (checked $i times)"
        break
    fi
    
    PID=$(lsof -ti :3123 2>/dev/null || echo "")
    if [ -n "$PID" ]; then
        echo "   ⚠️  Attempt $i: Found PID $PID, killing..."
        kill -9 $PID 2>/dev/null
    fi
    sleep 2
done

# Step 3: Final verification
echo "3️⃣ Final port verification..."
sleep 3
if lsof -ti :3123 &>/dev/null; then
    echo "❌ FAILED: Port 3123 is STILL in use after aggressive cleanup"
    echo ""
    echo "Current processes on port 3123:"
    lsof -i :3123
    echo ""
    echo "💡 Something is persistently binding to this port."
    echo "   Try using a different port by setting HTTP_PORT=3124 in .env"
    exit 1
fi

echo "   ✅ Port 3123 is FREE and stable"

# Step 4: Pre-build (outside of debug script to avoid timing issues)
echo "4️⃣ Building project..."
npm run build --silent

# Step 5: One more check before starting
echo "5️⃣ Pre-flight check..."
sleep 1
if lsof -ti :3123 &>/dev/null; then
    echo "❌ Port was grabbed during build!"
    kill -9 $(lsof -ti :3123)
    sleep 2
fi

# Step 6: Start server directly (skip npm to avoid spawning issues)
echo "6️⃣ Starting debug server..."
echo ""
LOG_LEVEL=debug HTTP_PORT=3123 AUTO_START=true DEBUG_START=true node dist/http-mcp-server.js

