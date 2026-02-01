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

### 8. Hooks Not Firing

**Problem:** Initially used `api.registerHook()` which doesn't work for plugins.

**Solution:** Use `api.on()` instead (learned from Promitheus plugin):
```typescript
api.on('message_received', (context) => { ... });
api.on('before_tool_call', (context) => { ... });
api.on('after_tool_call', (context, result) => { ... });
```

## Key Learnings

### OpenClaw Plugin Development

1. **Use `api.on()` for hooks**, not `api.registerHook()` - the latter doesn't work for plugins
2. **Tool registration requires `_id` parameter**: `async execute(_id: string) { ... }`
3. **Tool result format**: `{ content: [{ type: 'text', text: '...' }] }`
4. **Debug logging is essential** - console.log works and shows in gateway logs

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
- **Hooks**: `message_received`, `before_tool_call`, `after_tool_call` all firing
- **Events**: Collected, buffered, flushed to API
- **Database**: Events stored in NeonDB with correct agent_id
- **Dashboard**: Shows agents and events at app.moltwire.com

## Files Modified

- `moltwire-plugin/src/index.ts` - Hook registration, debug logging, tool fixes
- `moltwire-plugin/src/config.ts` - API key file path, debug logging
- `moltwire-api/src/routes/register.ts` - Database storage for tokens
- `moltwire-api/src/db/cache.ts` - Database functions for pending_registrations
- `moltwire-dashboard/src/app/login/page.tsx` - Preserve callbackUrl
- `moltwire-dashboard/src/app/api/keys/route.ts` - New proxy endpoint
