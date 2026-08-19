import { PipelineRegistry } from './CommitPipelineRegistry.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from './types.js';
import { FileClassifierDetector } from './detectors/FileClassifierDetector.js';
import { QualitySignalReader } from './detectors/QualitySignalReader.js';
import { RiskAnnotationRecognizer } from './recognizers/RiskAnnotationRecognizer.js';
import { QualityGateRecognizer } from './recognizers/QualityGateRecognizer.js';
import { CommentQualityRecognizer } from './recognizers/CommentQualityRecognizer.js';

/**
 * The default registry every MovementSession uses unless a caller supplies
 * its own — universal protections registered mandatory, per
 * docs/design/commit-check-pipeline.md "Decisions made".
 */
export function createDefaultCommitPipelineRegistry(): PipelineRegistry {
  const registry = new PipelineRegistry();

  registry.registerDetector(new FileClassifierDetector(), {
    hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
    mandatory: true,
  });

  registry.registerDetector(new QualitySignalReader(), {
    hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
    mandatory: true,
  });

  registry.registerRecognizer(new RiskAnnotationRecognizer(), {
    hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
    mandatory: true,
  });

  registry.registerRecognizer(new QualityGateRecognizer(), {
    hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
    mandatory: true,
  });

  registry.registerRecognizer(new CommentQualityRecognizer(), {
    hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
    mandatory: true,
  });

  return registry;
}

export const defaultCommitPipelineRegistry = createDefaultCommitPipelineRegistry();
