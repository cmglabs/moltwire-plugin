# @cmglabs/moltwire-plugin

Security & observability plugin for OpenClaw agents.

## Quick Start

1. Install the plugin:
   ```bash
   openclaw plugins install @cmglabs/moltwire-plugin
   ```

2. Message your agent - it will automatically guide you through setup and provide a registration URL.

3. Open the URL in your browser and complete signup.

That's it! Your agent is now protected by Moltwire.

## Features

- **Activity Monitoring** - Track tool executions, messages, and sessions
- **Anomaly Detection** - Local detection of suspicious patterns
- **Privacy-First** - Only metadata is collected, never message content
- **Network Protection** - Benefit from threat intelligence across all Moltwire agents

## Privacy

This plugin is designed with privacy as a core principle:

- **No message content** is ever captured or transmitted
- **No file contents** are captured
- **No credentials** or API keys are captured
- All identifiers are **hashed** before leaving your machine
- The plugin source code is **open source** for auditing

Only metadata is collected:
- Tool names and categories (not commands or arguments)
- Message length and type (not content)
- Session timing and configuration
- Anomaly indicators

## Configuration Options

These can be set in `~/.openclaw/openclaw.json` under `plugins.moltwire-plugin`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `flushIntervalSeconds` | number | `30` | Batch flush interval |
| `flushBatchSize` | number | `50` | Max events per batch |
| `redactPatterns` | boolean | `true` | Redact potential PII |
| `localAnomalyDetection` | boolean | `true` | Enable local anomaly detection |

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Type check
pnpm typecheck

# Run tests
pnpm test
```

## License

MIT
