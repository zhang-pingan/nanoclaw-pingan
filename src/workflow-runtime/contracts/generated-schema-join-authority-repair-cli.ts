import {
  checkGeneratedSchemaJoinAuthorityRepair,
  generateGeneratedSchemaJoinAuthorityRepair,
} from './generated-schema-join-authority-repair.js';

const command = process.argv[2];

if (command === 'generate') {
  generateGeneratedSchemaJoinAuthorityRepair(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../../docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md',
      ),
      'utf8',
    ),
  );
  console.log(
    'Generated generated-schema/join-authority repair Contract Pack.',
  );
} else if (command === 'check') {
  const pack = checkGeneratedSchemaJoinAuthorityRepair();
  console.log(
    `Generated-schema/join-authority repair Contract Pack OK: ${pack.hash}`,
  );
} else {
  console.error(
    'Usage: generated-schema-join-authority-repair <generate|check>',
  );
  process.exitCode = 1;
}
import fs from 'node:fs';
import path from 'node:path';
