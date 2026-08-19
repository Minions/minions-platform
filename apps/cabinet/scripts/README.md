# Cabinet Scripts

This directory contains utility scripts for cabinet development and demos.

## Demo Scripts

### demo.js

Starts the cabinet MCP server in development mode for demonstrations.

**Usage:**
```bash
node scripts/demo.js [options]
```

**Options:**
- `--wing-name <name>` - Name for the demo wing (default: cabinet-demo)
- `--port <port>` - Port for cabinet server (default: 3000)
- `--help` - Show help message

**What it does:**
1. Detects the lair root from the current wing structure
2. Sets LAIR_ROOT and CABINET_PORT environment variables
3. Starts cabinet server using `pnpm dev`
4. Displays MCP connection instructions after 3 seconds

**Example:**
```bash
node scripts/demo.js --wing-name my-demo --port 3001
```

### install-costume.js

Automates costume installation to a wing's closet via MCP tools.

**Usage:**
```bash
node scripts/install-costume.js [options]
```

**Options:**
- `--source-wing <name>` - Wing containing the costume source (default: workshop-00)
- `--costume-path <path>` - Path within work/local (default: costumes/dev-and-check)
- `--costume-name <name>` - Name to install as (default: dev-and-check)
- `--target-wing <name>` - Wing to install into (default: cabinet-demo)
- `--port <port>` - Cabinet server port (default: 3000)
- `--help` - Show help message

**What it does:**
1. Initializes MCP session with cabinet server
2. Checks if target wing exists (creates it if needed)
3. Calls `costumes_debug_install` MCP tool with `targetWingName` parameter
4. Displays installation paths and next steps

**Prerequisites:**
- Cabinet server must be running (start with `demo.js`)
- Source wing must contain the costume at the specified path
- Target wing will be created if it doesn't exist

**Example:**
```bash
# In terminal 1: Start cabinet
node scripts/demo.js

# In terminal 2: Install costume
node scripts/install-costume.js --target-wing my-demo
```

## Complete Demo Workflow

1. **Start cabinet server:**
   ```bash
   node scripts/demo.js --wing-name demo-wing
   ```

2. **In a new terminal, install costume:**
   ```bash
   node scripts/install-costume.js --target-wing demo-wing
   ```

3. **Connect your MCP client:**
   - Configure your client to connect to one of the MCP endpoints: `/mcp/henchery`, `/mcp/lair`, `/mcp/conductor`, or `/mcp/throne`
   - Available tools include: `mission_list`, `mission_start`, and many more

4. **List available missions:**
   Use MCP tool `mission_list` with `wingName: "demo-wing"`

5. **Start the orchestrate mission:**
   Use MCP tool `mission_start` with:
   - `wingName: "demo-wing"`
   - `costume: "dev-and-check"`
   - `mission: "orchestrate"`

## Build Scripts

### build.js

Compiles TypeScript cabinet source using esbuild.

### copy-throne-room.js

Copies the throne-room UI build output to cabinet's dist directory.

### create-lair-package.js

Creates a new_lair.zip package with the cabinet runtime and lair directory structure.
