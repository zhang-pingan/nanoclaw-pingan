import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { renderLaunchdPlist } from './launchd.js';
import { getRuntimeLauncherPath } from './platform.js';
import { renderNohupWrapper, renderSystemdUnit } from './service.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const homeDir = '/Users/tester';
const launcher = getRuntimeLauncherPath(homeDir);

describe('Core service launch identity', () => {
  it('renders launchd with the stable Runtime Launcher as its only program argument', () => {
    const plist = renderLaunchdPlist(projectRoot, launcher, homeDir);
    const argumentsBlock = plist.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );

    expect(argumentsBlock).not.toBeNull();
    expect(argumentsBlock![1].match(/<string>/g)).toHaveLength(1);
    expect(argumentsBlock![1]).toContain(`<string>${launcher}</string>`);
    expect(argumentsBlock![1]).not.toContain('dist/index.js');
    expect(plist).not.toContain('{{RUNTIME_LAUNCHER}}');
    expect(plist).not.toContain('{{NODE_PATH}}');
  });

  it('renders systemd and nohup with the same stable Launcher', () => {
    const userUnit = renderSystemdUnit(launcher, '/srv/icarus', homeDir, false);
    const systemUnit = renderSystemdUnit(
      launcher,
      '/srv/icarus',
      homeDir,
      true,
    );
    const wrapper = renderNohupWrapper(
      launcher,
      '/srv/icarus',
      '/srv/icarus/icarus.pid',
    );

    expect(userUnit).toContain(`ExecStart=${JSON.stringify(launcher)}`);
    expect(userUnit).toContain('WantedBy=default.target');
    expect(systemUnit).toContain('WantedBy=multi-user.target');
    expect(userUnit).not.toMatch(/ExecStart=.*\bnode\b/);
    expect(wrapper).toContain(`nohup ${JSON.stringify(launcher)}`);
    expect(wrapper).not.toContain('dist/index.js');
  });

  it('routes local rebuild/restart through the managed toolchain', () => {
    for (const script of ['restart.sh', 'restart-no-cache.sh']) {
      const source = fs.readFileSync(
        path.join(projectRoot, 'local', 'shell', script),
        'utf8',
      );
      expect(source).toContain('"$RUNTIME_TOOLCHAIN" install');
      expect(source).toContain('"$RUNTIME_TOOLCHAIN" exec -- npm run build');
      expect(source).not.toMatch(/^npm run build$/m);
    }

    const common = fs.readFileSync(
      path.join(projectRoot, 'local', 'shell', 'common.sh'),
      'utf8',
    );
    expect(common).not.toContain('command -v node');
    expect(common).not.toContain('{{NODE_PATH}}');
    expect(common).toContain('{{RUNTIME_LAUNCHER}}');

    const groups = fs.readFileSync(
      path.join(projectRoot, 'setup', 'groups.ts'),
      'utf8',
    );
    expect(groups).toContain("['exec', '--', 'npm', 'run', 'build']");
    expect(groups).not.toContain("execSync('npm run build'");
  });
});
