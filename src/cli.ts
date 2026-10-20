import { dataDirectory } from "./config.js";
import { InboxLog, recoverLock } from "./storage/inbox-log.js";
import { safeCode } from "./errors.js";

try {
  const command = process.argv[2];
  const directory = dataDirectory();
  if (command === "recover-lock") {
    recoverLock(directory);
    console.log("Removed a verified dead process lock. No captured data changed.");
  } else if (command === "status" || command === "retry") {
    // Offline CLI commands require sole ownership. Use Telegram /status while the bot runs.
    const log = new InboxLog(directory);
    try {
      if (command === "retry") {
        let count = 0;
        for (const state of log.messages()) {
          if (state.failure && !state.confirmed) {
            log.record({ type: "retry", sourceId: state.capture.sourceId, resetAttempts: true });
            count++;
          }
        }
        console.log("Requeued " + count + " message(s). Start the service to process them.");
      }
      console.log(JSON.stringify(log.status()));
    } finally { log.close(); }
  } else {
    throw new Error("Unsupported command");
  }
} catch (error) {
  console.error("Command failed: " + safeCode(error));
  process.exitCode = 1;
}

