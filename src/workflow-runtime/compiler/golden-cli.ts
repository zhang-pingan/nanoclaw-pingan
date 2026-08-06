import {
  checkGoldenCorpus,
  replayGoldenCorpus,
  updateGoldenCorpus,
} from './golden.js';

const command = process.argv[2];
try {
  const result =
    command === 'update'
      ? updateGoldenCorpus(process.argv[3])
      : command === 'check'
        ? checkGoldenCorpus()
        : command === 'replay'
          ? replayGoldenCorpus()
          : null;
  if (!result) {
    console.error('Usage: golden <update [reason]|check|replay>');
    process.exitCode = 64;
  } else if (result.mismatchedCaseIds.length > 0) {
    console.error(
      `golden_${command}=failed mismatches=${result.mismatchedCaseIds.join(',')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `golden_${command}=ok exact_equal=${result.exactCount}/${result.caseCount}`,
    );
  }
} catch (error) {
  console.error(
    `golden_${command ?? 'unknown'}=failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
