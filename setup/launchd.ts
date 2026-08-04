import fs from 'fs';
import path from 'path';

const LAUNCHD_TEMPLATE = path.join('launchd', 'com.icarus.plist');

export function renderLaunchdPlist(
  projectRoot: string,
  hostLauncherPath: string,
  homeDir: string,
  mode: 'current' | 'active' = 'current',
): string {
  const templatePath = path.join(projectRoot, LAUNCHD_TEMPLATE);
  const template = fs.readFileSync(templatePath, 'utf-8');

  return template
    .replaceAll('{{HOST_LAUNCHER}}', hostLauncherPath)
    .replaceAll('{{HOST_MODE}}', mode)
    .replaceAll('{{PROJECT_ROOT}}', projectRoot)
    .replaceAll('{{HOME}}', homeDir);
}
