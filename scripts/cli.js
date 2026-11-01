#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const packageJson = require('../package.json');
const { createCodegenCommand } = require('../dist/cli/codegen');
const { createSyncCommand } = require('../dist/cli/sync');

const program = new Command()
  .name('pynect')
  .description('Generate types and manage Pynect projects.')
  .version(packageJson.version)
  .showHelpAfterError();

program.addCommand(createCodegenCommand());
program.addCommand(createSyncCommand());

program.parseAsync(process.argv).catch(error => {
  console.error(`pynect: ${error.message}`);
  process.exitCode = 1;
});
