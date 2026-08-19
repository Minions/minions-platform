import { ChangeAnalyzer, FileType } from '../../risk/ChangeAnalyzer.js';
import type { Detector, Evidence, PipelineContext } from '../types.js';

export interface FileClassificationPayload {
  classification: Record<string, FileType>;
}

/**
 * Built-in Detector, absorbed from ChangeAnalyzer.classifyFile — the first
 * detector in the pipeline, per docs/design/commit-check-pipeline.md
 * "Relationship to existing systems".
 */
export class FileClassifierDetector implements Detector {
  readonly id = 'file-classifier';
  private readonly changeAnalyzer = new ChangeAnalyzer();

  async detect(ctx: PipelineContext, _evidenceSoFar: Evidence[]): Promise<Evidence[]> {
    const classification: Record<string, FileType> = {};
    for (const file of ctx.changedFiles) {
      classification[file] = this.changeAnalyzer.classifyFile(file);
    }

    return [{ producer: this.id, kind: 'file-classification', payload: { classification } }];
  }
}

export function getFileClassification(evidence: Evidence[]): Record<string, FileType> | undefined {
  const found = evidence.find((e) => e.kind === 'file-classification');
  return (found?.payload as FileClassificationPayload | undefined)?.classification;
}
