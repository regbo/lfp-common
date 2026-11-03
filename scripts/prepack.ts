import { runBun } from './process.ts';
import { ROOT, WORKSPACES } from './workspaces.ts';

const name = process.argv[2];
const workspace = WORKSPACES.find(candidate => candidate.name === name);
if (!workspace) throw new TypeError(`Unknown workspace for prepack: ${name ?? '<missing>'}.`);

if (process.env.LFP_JS_SKIP_PREPACK === '1') {
  console.log(`Skipping duplicate ${workspace.name} prepack checks in the trusted publish workflow.`);
} else {
  await runBun(['run', 'verify'], {
    cwd: ROOT,
    inherit: true,
  });
}
