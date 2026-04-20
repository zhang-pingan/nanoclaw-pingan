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

  return template
    .replaceAll('{{NODE_PATH}}', nodePath)
    .replaceAll('{{PROJECT_ROOT}}', projectRoot)
    .replaceAll('{{HOME}}', homeDir);
}
