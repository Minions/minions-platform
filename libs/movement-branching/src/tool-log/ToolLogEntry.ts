export interface ToolLogEntry {
  timestamp: number;
  tool: string;
  filePath?: string;
  command?: string;
  mcpAction?: string;
  /** Lines changed in the file (for Edit/Write entries); used for LOC-based risk assessment */
  linesChanged?: number;
}
