import { runCommand } from "./process.js";

if (process.env.LOQKIT_SKIP_PREPACK === "1") {
  console.log("Skipping duplicate prepack checks in the trusted publish workflow");
} else {
  await runCommand(process.execPath, ["run", "check"], { inherit: true });
}
