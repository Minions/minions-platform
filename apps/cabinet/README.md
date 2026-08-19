# Cabinet

Express + TypeScript backend server that manages secretaries and serves the Throne Room UI.

## Features

- Serves Throne Room static files at `/` route
- Provides `/api/secretary/status` endpoint
- Manages Code Execution Secretary (currently inactive)
- MCP server support (future)

## Environment Variables

Cabinet requires the following environment variables:

- `ANTHROPIC_API_KEY` - Your Anthropic API key (required for lightweight minions)
- `CABINET_PORT` - Port to run the server on (default: 3000)
- `LAIR_ROOT` - Root directory of the lair (default: current working directory)

Example:
```bash
export ANTHROPIC_API_KEY=your-api-key-here
export LAIR_ROOT=/path/to/your/lair
pnpm dev
```

## Development

The cabinet serves a built copy of the Throne Room UI in production. In **dev mode**, both servers run separately so each has live hot-reload:

- **Cabinet** (this app) runs at `http://localhost:3000` with nodemon (auto-restarts on changes)
- **Throne Room** (Vue frontend) runs at `http://localhost:5173` with Vite HMR
- CORS between the two is pre-configured — no extra setup needed

### Starting dev mode

**Preferred — start both from the workspace root (`work/local`):**

```bash
pnpm dev
```

**Or from this directory (same result):**

```bash
pnpm dev          # starts cabinet + throne-room together
```

Open **http://localhost:5173** for the live UI with HMR.

### Other commands

```bash
pnpm dev:backend  # Cabinet backend only (no UI)
pnpm build        # Build for production (includes throne-room)
pnpm start        # Run production build
pnpm test         # Run tests
```

## Architecture

- **server.ts**: Express server configuration
- **secretary.ts**: Code Execution Secretary implementation
- **main.ts**: Server entry point

## API Endpoints

### GET /api/secretary/status

Returns the current status of the Code Execution Secretary.

Response:
```json
{
  "isActive": false,
  "lastActivity": null
}
```

## Testing

All server functionality is tested using Vitest following TDD principles.