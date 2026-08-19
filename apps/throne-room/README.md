# Throne Room

Vue 3 + TypeScript frontend for the Execution Throne Room, displaying the status of the Code Execution Secretary.

## Features

- Displays Code Execution Secretary status (Active/Inactive)
- Shows last activity timestamp
- Real-time status updates (future)

## Development

```bash
pnpm install
pnpm dev         # Start development server
pnpm build       # Build for production
pnpm test        # Run tests in watch mode
pnpm test:run    # Run tests once
```

## Architecture

- **SecretaryStatus.vue**: Component displaying secretary status
- **App.vue**: Main application component
- **main.ts**: Application entry point

## Testing

All components are tested using Vitest and Vue Test Utils following TDD principles.