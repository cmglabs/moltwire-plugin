# Moltwire Plugin Debugging - Feb 1, 2026

## Summary

Successfully debugged and got the Moltwire OpenClaw plugin working end-to-end: plugin → API → NeonDB → Dashboard.

## Problems Encountered

### 1. Registration Token Lost Across Cloud Run Instances

**Problem:** The registration flow (`moltwire setup` → browser signup → API key returned) was failing because registration tokens were stored in-memory on Cloud Run. When the user completed signup, the request hit a different instance that didn't have the token.

**Solution:** Moved from in-memory cache to NeonDB `pending_registrations` table:
```sql
CREATE TABLE pending_registrations (
  token VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL,
  platform VARCHAR(50),
  node_version VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  api_key VARCHAR(64),
  user_id UUID
);
```

### 2. Token Lost During Login → Signup Navigation

**Problem:** When user clicked "Sign up" from the login page, the `callbackUrl` query parameter (containing the registration token) was being lost.

**Solution:** Fixed `/login/page.tsx` to preserve the callbackUrl:
```typescript
href={`/signup${callbackUrl !== '/dashboard' ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ''}`}
```

### 3. 404 on /api/keys Endpoint

**Problem:** Dashboard was calling `/api/keys` but that endpoint didn't exist in the Next.js app.

**Solution:** Created `/src/app/api/keys/route.ts` to proxy requests to the external API.

### 4. Plugin Expected Wrong Response Format

**Problem:** Plugin checked `data.status === 'completed'` but API returned `data.complete === true`.

**Solution:** Fixed the condition in `moltwire_check_registration` tool:
```typescript
if (data.complete && data.api_key) {
  // Handle success
}
```

### 5. API Key File Path Mismatch

**Problem:** Code looked for `~/.openclaw/moltwire/api-key` but file was saved as `api_key`.

**Solution:** Fixed path in `config.ts` to use `api_key`.

### 6. Setup URL Wrong

**Problem:** Plugin generated `/dashboard/setup?token=xxx` but should be `/setup?token=xxx&agent=xxx`.

**Solution:** Fixed URL generation in `moltwire_setup` tool.

### 7. Sender Not Updated After Registration

**Problem:** After `check_registration` saved the new API key to file, the `sender` object still had the old (empty) API key, causing "Invalid API key" errors on flush.

**Solution:** Update the sender and enable monitoring when registration completes:
```typescript
if (data.complete && data.api_key) {
  saveApiKey(data.api_key);
  clearPendingToken();

  // Update the sender with the new API key (no restart needed)
  sender.setApiKey(data.api_key);

  // Enable monitoring if not already enabled
  if (!isEnabled) {
    if (!flushInterval) {
      flushInterval = setInterval(() => flush(), config.flushIntervalSeconds * 1000);
    }
    threats.start();
    isEnabled = true;
  }
}
```

### 8. `enabled: false` Despite Plugin Starting

**Problem:** `moltwire_status` showed `enabled: false` even though logs showed "Plugin started".

**Root Cause:** The async `start()` function was being called but status was being checked before it completed. Also, the gateway needed to be restarted after fixing the code.

**Solution:** Added extensive debug logging to trace the flow:
```typescript
console.log('[Moltwire] start() called, hasApiKey:', validation.hasApiKey);
console.log('[Moltwire] start() proceeding with API key verification');
console.log('[Moltwire] isEnabled set to true');
console.log('[Moltwire] status tool called, isEnabled =', isEnabled);
```

### 8. Hooks Not Firing (SUPERSEDED)

**Problem:** Initially used `api.registerHook()` which doesn't work for plugins. Then tried `api.on()` but `before_tool_call` and `after_tool_call` don't exist in OpenClaw.

**Solution:** Abandoned hooks entirely. Use log file parsing instead (see #9).

### 9. OpenClaw Has No Tool Execution Hooks

**Problem:** OpenClaw doesn't emit `before_tool_call` or `after_tool_call` events. Only `message_received` and `before_agent_start` work.

**Solution:** Parse the OpenClaw log file directly using `LogWatcher` class:
```typescript
// Log file location: /tmp/openclaw/openclaw-YYYY-MM-DD.log
// Use tail -F to follow the log file
this.tailProcess = spawn('tail', ['-F', '-n', '0', this.logPath]);

// Parse JSON log lines for tool executions
if (message.includes('embedded run tool start:')) {
  // Extract runId, tool, toolCallId
}
if (message.includes('embedded run tool end:')) {
  // Calculate duration, emit event
}
```

### 10. Dashboard Field Mismatch (API vs Components)

**Problem:** Dashboard crashed with `Cannot read properties of undefined (reading 'toUpperCase')`.

**Root Cause:** API returned `{ tool: "read" }` but dashboard expected `{ tool_name: "read" }`. Also, events API returned events without `severity` or `message` fields that components expected.

**Solution:**
1. Fixed API to return `tool_name` instead of `tool` in `top_tools_24h`
2. Fixed dashboard components to handle missing fields gracefully:
```typescript
const toolName = event.tool_name || (event.payload as Record<string, unknown>)?.tool_name as string;
const severity = event.severity || 'info';
const message = event.message || event.event_type.replace(/_/g, ' ');
```

### 11. Dashboard Recent Events Returned Empty

**Problem:** `getRecentEvents()` in api-client.ts was hardcoded to return empty array.

**Solution:**
1. Added `/v1/dashboard/events` endpoint to API for global recent events
2. Updated dashboard to call actual endpoint instead of returning `[]`

## Key Learnings

### OpenClaw Plugin Development

1. **NO tool execution hooks exist** - `before_tool_call` and `after_tool_call` don't work
2. **Use log file parsing** to capture tool executions via `LogWatcher`
3. **Tool registration requires `_id` parameter**: `async execute(_id: string) { ... }`
4. **Tool result format**: `{ content: [{ type: 'text', text: '...' }] }`
5. **Debug logging is essential** - console.log works and shows in gateway logs
6. **Log file format**: JSON lines at `/tmp/openclaw/openclaw-YYYY-MM-DD.log`

### Cloud Run Deployment

1. **Stateless by design** - don't store anything in memory that needs to persist across requests
2. **Multiple instances** - any request can hit any instance
3. **Manual deploy**: `gcloud run deploy moltwire-api --source . --region us-central1`

### Gateway Management

1. **Start gateway**: `openclaw gateway` (not `openclaw-gateway`)
2. **Logs location**: `/tmp/gw.log` (if started with `> /tmp/gw.log 2>&1`)
3. **Main log file**: `/tmp/openclaw/openclaw-2026-02-01.log`
4. **Restart required** after deploying new plugin code

### Registration Flow

```
1. User runs `moltwire setup` in agent
2. Plugin calls POST /v1/register/init with token + agent_id
3. Token stored in pending_registrations table
4. Plugin returns URL: app.moltwire.com/setup?token=xxx&agent=xxx
5. User opens URL, signs up/logs in
6. Dashboard calls POST /v1/register/complete with token + user session
7. API creates API key, updates pending_registrations
8. User runs `moltwire check_registration` in agent
9. Plugin calls GET /v1/register/status?token=xxx
10. API returns { complete: true, api_key: "mw_live_..." }
11. Plugin saves API key to ~/.openclaw/moltwire/api_key
12. User restarts gateway
13. Plugin loads with API key, starts collecting events
```

## Final Working State

- **Plugin**: Loads with API key, `isEnabled = true`
- **Log Watcher**: Parses `/tmp/openclaw/openclaw-YYYY-MM-DD.log` for events
- **Events Captured**: `inbound_message` and `tool_execution` (with tool names like `web_fetch`, `read`, `exec`)
- **Database**: Events stored in NeonDB with correct agent_id and tool_name in payload
- **Dashboard**: Shows agents, top tools, and recent events at app.moltwire.com

## Files Modified

### Plugin
- `moltwire-plugin/src/index.ts` - Removed hooks, added log watcher integration
- `moltwire-plugin/src/log-watcher.ts` - NEW: Parses OpenClaw log file for events
- `moltwire-plugin/src/config.ts` - API key file path, debug logging

### API
- `moltwire-api/src/routes/register.ts` - Database storage for tokens
- `moltwire-api/src/routes/dashboard.ts` - Added `/events` endpoint for recent events
- `moltwire-api/src/services/dashboard.ts` - Fixed `tool_name` field, added `getRecentEvents()`
- `moltwire-api/src/types/dashboard.ts` - Fixed `tool_name` in type definition
- `moltwire-api/src/db/cache.ts` - Database functions for pending_registrations

### Dashboard
- `moltwire-dashboard/src/app/login/page.tsx` - Preserve callbackUrl
- `moltwire-dashboard/src/app/api/keys/route.ts` - New proxy endpoint
- `moltwire-dashboard/src/lib/api-client.ts` - Fixed `getRecentEvents()` to call API
- `moltwire-dashboard/src/components/dashboard/RecentEvents.tsx` - Handle missing fields
- `moltwire-dashboard/src/components/dashboard/EventTimeline.tsx` - Handle missing fields
- `moltwire-dashboard/src/components/dashboard/AlertDetail.tsx` - Handle missing fields
