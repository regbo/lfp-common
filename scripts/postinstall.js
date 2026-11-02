'use strict';

const fs = require('fs');
const path = require('path');

function disabled(value) {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value);
}

async function main() {
  if (disabled(process.env.PYNECT_SKIP_POSTINSTALL)) return;

  const projectRoot = path.resolve(
    process.env.INIT_CWD || process.env.npm_config_local_prefix || process.cwd(),
  );
  const environmentModule = path.join(__dirname, '..', 'dist', 'env', 'project-environment.js');

  // Published packages contain dist. A source checkout may install dependencies
  // before its first TypeScript build, so its normal verify/build flow owns setup.
  if (!fs.existsSync(environmentModule)) return;

  const {
    createProjectPlan,
    requiresProjectSync,
    syncProject,
  } = require(environmentModule);
  const plan = createProjectPlan({ projectRoot });
  if (!requiresProjectSync(plan)) return;

  const result = await syncProject({ projectRoot });
  console.log(
    `[pynect] Prepared ${result.plan.dependencies.length} Python dependency constraint(s) ` +
    `with Pyfig in ${result.environment.python.virtualEnvironment}.`,
  );
}

main().catch(error => {
  console.error(`[pynect] Postinstall synchronization failed: ${error.message}`);
  process.exitCode = 1;
});
