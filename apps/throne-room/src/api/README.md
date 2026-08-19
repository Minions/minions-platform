# Throne Room API Client

## MCP Client

The `cabinet.ts` module provides a client for calling Cabinet server tools via MCP.

### Usage

```typescript
import { callMCP } from './api/cabinet';

const wings = await callMCP('districts_list', {});
```

### Configuration

Set `VITE_CABINET_URL` environment variable to point to Cabinet server.
Defaults to `http://localhost:3000`.
