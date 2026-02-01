# @moltwire/openclaw-plugin

Security & observability plugin for OpenClaw agents.

## Features

- **Activity Monitoring** - Track tool executions, messages, and sessions
- **Anomaly Detection** - Local detection of suspicious patterns
- **Privacy-First** - Only metadata is collected, never message content
- **Network Protection** - Benefit from threat intelligence across all Moltwire agents

## Installation

```bash
openclaw plugins install @moltwire/openclaw-plugin
```

## Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "@moltwire/openclaw-plugin": {
      "apiKey": "mw_live_your_key_here"
    }
  }
}
```

Get your API key at [https://moltwire.com/dashboard/setup](https://moltwire.com/dashboard/setup)

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `apiKey` | string | required | Your Moltwire API key |
| `apiEndpoint` | string | `https://api.moltwire.com` | API endpoint |
| `flushIntervalSeconds` | number | `30` | Batch flush interval |
| `flushBatchSize` | number | `50` | Max events per batch |
| `redactPatterns` | boolean | `true` | Redact potential PII |
| `localAnomalyDetection` | boolean | `true` | Enable local anomaly detection |
| `captureToolExecution` | boolean | `true` | Capture tool events |
| `captureInboundMessages` | boolean | `true` | Capture message metadata |
| `captureSessionLifecycle` | boolean | `true` | Capture session events |
| `captureConfigChanges` | boolean | `true` | Capture config changes |
| `debug` | boolean | `false` | Enable debug logging |

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
