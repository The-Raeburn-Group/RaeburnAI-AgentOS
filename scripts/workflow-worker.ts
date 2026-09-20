import { env } from "../src/lib/env";
import { processNextWorkflowJob } from "../src/lib/workflow-queue";

const workerId =
  process.env.WORKFLOW_WORKER_ID ?? `workflow-worker-${process.pid}`;

let stopping = false;

function stop() {
  stopping = true;
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function main() {
  while (!stopping) {
    const processed = await processNextWorkflowJob({ workerId });
    if (!processed) {
      await new Promise((resolve) =>
        setTimeout(resolve, env.WORKFLOW_JOB_POLL_MS),
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
