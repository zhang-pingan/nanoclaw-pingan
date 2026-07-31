import {
  checkContractPackStaticAbsence,
  generateContractPackStaticAbsence,
} from './static-absence-pack.js';

const command = process.argv[2];
const pack =
  command === 'generate'
    ? generateContractPackStaticAbsence()
    : command === 'check'
      ? checkContractPackStaticAbsence()
      : null;
if (!pack) throw new Error('Usage: static-absence-cli.ts <generate|check>');
console.log(`contract_pack_static_absence=${command}:ok`);
console.log(`contract_pack_static_absence_hash=${pack.hash}`);
