import fs from 'fs';
import path from 'path';

const LAUNCHD_TEMPLATE = path.join('launchd', 'com.nanoclaw.plist');

export function renderLaunchdPlist(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): string {
  const templatePath = path.join(projectRoot, LAUNCHD_TEMPLATE);
  const template = fs.readFileSync(templatePath, 'utf-8');
  const nodeBinDir = path.dirname(nodePath);

  return template
    .replaceAll('{{NODE_PATH}}', nodePath)
    .replaceAll('{{NODE_BIN_DIR}}', nodeBinDir)
    .replaceAll('{{PROJECT_ROOT}}', projectRoot)
    .replaceAll('{{HOME}}', homeDir);
}
