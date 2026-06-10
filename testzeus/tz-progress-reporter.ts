import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const progressPath = resolve(here, "test-results", "progress.json");

function writeProgress(payload: { step: string; index: number; category: string }) {
  try {
    mkdirSync(dirname(progressPath), { recursive: true });
    writeFileSync(
      progressPath,
      JSON.stringify({ ...payload, at: Date.now() }),
      "utf8",
    );
  } catch {
    // Non-fatal — progress is best-effort for live UI feedback.
  }
}

class TzProgressReporter implements Reporter {
  private stepIndex = 0;

  onBegin() {
    this.stepIndex = 0;
    writeProgress({
      step: "Starting browser automation",
      index: 0,
      category: "hook",
    });
  }

  onStepBegin(_test: TestCase, _result: TestResult, step: TestStep) {
    this.stepIndex += 1;
    writeProgress({
      step: step.title,
      index: this.stepIndex,
      category: step.category,
    });
  }
}

export default TzProgressReporter;
