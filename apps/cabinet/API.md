# Cabinet API

## Health Check
GET /health -> { status: 'ok', timestamp: number }

## MCP Endpoint
POST /mcp -> MCP JSON-RPC protocol

### Supported Methods
- `initialize` - Initialize MCP connection

## Wing Management

### Wing Model
- Represents a workspace with work/local, work/global, private/, and info/
- Loaded from filesystem structure

### WingManager
- Scans for wings in `wings/` directory
- Lists available work repositories
- Detects git worktree mappings
- Creates new wings with git worktrees

### wings_create
Creates a new wing with git worktrees.

**Arguments:**
- name: string - Wing name
- workLocalRepo: string - Work repo to use
- workLocalBranch: string - Branch name
- workGlobalRepo?: string - Optional global work repo
- workGlobalBranch?: string - Optional global branch name

## Costume Management

### costumes_debug_install
Debug install a costume by creating symlinks from the lair's closet to a wing's work/local costume source.

**Arguments:**
- wingName: string - Name of the wing containing the costume source
- costumePath: string - Path to the costume within work/local (e.g., "costumes/my-costume")
- installedName: string - Name to install the costume as in the closet

**Returns:**
- message: string - Success message
- closetLink: string - Path to the created closet link
- commandsLink?: string - Path to commands link (if missions dir exists)
- agentsLink?: string - Path to agents link (if disguises dir exists)

**Behavior:**
1. Creates link: `closet/<installedName>` -> `wings/<wingName>/work/local/<costumePath>/src/`
2. If `missions/` exists in costume src, creates: `.claude/commands/<installedName>` -> `closet/<installedName>/missions`
3. If `disguises/` exists in costume src, creates: `.claude/agents/<installedName>` -> `closet/<installedName>/disguises`

On Windows, uses junctions (no admin required). On other platforms, uses symlinks.
