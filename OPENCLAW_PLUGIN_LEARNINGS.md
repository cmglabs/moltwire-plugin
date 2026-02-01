# OpenClaw Plugin Development Learnings

This document captures lessons learned while developing the Moltwire plugin for OpenClaw.

## Critical: The `.some()` Error

**Error:** `[openclaw] Cannot read properties of undefined (reading 'some')`

This error occurs when OpenClaw tries to process plugin registrations incorrectly.

### Root Cause
The `execute` function in tool registrations must include an `_id` parameter as the first argument, even if unused.

### Wrong (causes `.some()` error):
```javascript
api.registerTool({
    name: 'my_tool',
    description: '...',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {  // <-- WRONG: missing _id parameter
        return { ... };
    }
});
```

### Correct:
```javascript
api.registerTool({
    name: 'my_tool',
    description: '...',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_id) {  // <-- CORRECT: include _id parameter
        return { ... };
    }
});
```

## Tool Result Format

Use this format for tool results (matches Promitheus pattern):

```javascript
function textResult(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
```

**Not** this simpler format (may cause issues):
```javascript
// Don't use this
return { type: 'text', text: JSON.stringify(data) };
```

## Hook Registration

For plugins, use `api.on()` for hooks, **not** `api.registerHook()`:

```javascript
// Correct - use api.on()
api.on('before_agent_start', async () => {
    // ...
});

// Wrong - don't use registerHook for plugins
api.registerHook({ name: '...', on: '...', handler: ... });
```

## Plugin Manifest (openclaw.plugin.json)

### Minimal working format:
```json
{
  "id": "moltwire",
  "name": "Moltwire Security",
  "version": "0.1.0",
  "description": "...",
  "configSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

### Key points:
- **Don't** include an `entry` field - OpenClaw expects `index.js` or `index.ts` at the root
- **Don't** include a `hooks` array in the manifest (register hooks in code with `api.on()`)
- **Don't** make `apiKey` required in configSchema if you want the plugin to load without it

## File Structure

OpenClaw expects plugin files at the extension root, not in a `dist/` subfolder:

```
~/.openclaw/extensions/moltwire/
├── index.js          # Main entry point (required)
├── openclaw.plugin.json
├── package.json
└── ... other .js files
```

**Not** this structure:
```
~/.openclaw/extensions/moltwire/
├── dist/
│   └── index.js      # Won't be found unless entry field specified
├── openclaw.plugin.json
└── package.json
```

## Deployment to Remote Server

When deploying to remote server (64.227.59.86):

```bash
# Copy built files directly to extension root
scp dist/*.js root@64.227.59.86:/root/.openclaw/extensions/moltwire/

# Copy manifest
scp openclaw.plugin.json root@64.227.59.86:/root/.openclaw/extensions/moltwire/

# Restart gateway
ssh root@64.227.59.86 "pkill -f openclaw"
ssh root@64.227.59.86 "nohup /usr/bin/openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &"

# Check logs
ssh root@64.227.59.86 "cat /tmp/openclaw.log"
```

## Config Handling

The plugin loads config from multiple sources in priority order:
1. `userConfig` passed to plugin function
2. `~/.openclaw/moltwire/api-key` file
3. `~/.openclaw/moltwire/config.json` file
4. Default values

When testing fresh setup, remember to delete old config:
```bash
rm -f /root/.openclaw/moltwire/api-key /root/.openclaw/moltwire/config.json
```

## Reference: Working Minimal Plugin

```javascript
import { randomUUID } from 'crypto';

function textResult(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export default function moltwirePlugin(api, userConfig = {}) {
    api.logger?.info?.('[Moltwire] Plugin loading...');

    api.registerTool({
        name: 'moltwire_setup',
        description: 'Initialize Moltwire setup',
        parameters: { type: 'object', properties: {}, required: [] },
        async execute(_id) {  // <-- Note: _id parameter required!
            return textResult({
                success: true,
                message: 'It works!'
            });
        }
    });

    api.logger?.info?.('[Moltwire] Plugin loaded');
}
```

## Promitheus Plugin as Reference

The Promitheus plugin at `/root/.openclaw/extensions/promitheus/index.ts` is a good working reference. Key patterns:
- Uses `api.on('before_agent_start', ...)` for hooks
- Uses `api.registerTool({ ..., async execute(_id, params) { ... } })` for tools
- Uses `{ content: [{ type: 'text', text: ... }] }` for results
