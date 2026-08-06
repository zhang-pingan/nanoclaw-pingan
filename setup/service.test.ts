import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { renderLaunchdPlist } from './launchd.js';
import {
  childProcessFailureDetail,
  renderNohupWrapper,
  renderSystemdUnit,
} from './service.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const homeDir = '/Users/tester';
const hostLauncher = path.join(projectRoot, 'local', 'shell', 'launch-host.sh');

describe('Core service launch compatibility', () => {
  it('preserves native-module rebuild guidance from child stderr', () => {
    expect(
      childProcessFailureDetail({
        stderr: Buffer.from(
          'better-sqlite3 failed; run npm rebuild better-sqlite3 or npm ci\n',
        ),
      }),
    ).toBe('better-sqlite3 failed; run npm rebuild better-sqlite3 or npm ci');
  });

  it('renders launchd with one explicit Host mode', () => {
    const plist = renderLaunchdPlist(projectRoot, hostLauncher, homeDir);
    const argumentsBlock = plist.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );

    expect(argumentsBlock).not.toBeNull();
    expect(argumentsBlock![1].match(/<string>/g)).toHaveLength(3);
    expect(argumentsBlock![1]).toContain(`<string>${hostLauncher}</string>`);
    expect(argumentsBlock![1]).toContain('<string>--mode</string>');
    expect(argumentsBlock![1]).toContain('<string>current</string>');
    expect(argumentsBlock![1]).not.toContain('dist/index.js');
    expect(plist).not.toContain('{{HOST_LAUNCHER}}');
    expect(plist).not.toContain('{{HOST_MODE}}');
    expect(plist).not.toContain('{{NODE_PATH}}');
  });

  it('renders systemd and nohup with the explicit current Host mode', () => {
    const userUnit = renderSystemdUnit(
      hostLauncher,
      '/srv/icarus',
      homeDir,
      false,
    );
    const systemUnit = renderSystemdUnit(
      hostLauncher,
      '/srv/icarus',
      homeDir,
      true,
    );
    const wrapper = renderNohupWrapper(
      hostLauncher,
      '/srv/icarus',
      '/srv/icarus/icarus.pid',
    );

    expect(userUnit).toContain(
      `ExecStart=${JSON.stringify(hostLauncher)} --mode current`,
    );
    expect(userUnit).toContain('WantedBy=default.target');
    expect(systemUnit).toContain('WantedBy=multi-user.target');
    expect(userUnit).not.toMatch(/ExecStart=.*\bnode\b/);
    expect(wrapper).toContain(
      `nohup ${JSON.stringify(hostLauncher)} --mode current`,
    );
    expect(wrapper).not.toContain('dist/index.js');
  });

  it('routes local rebuild/restart through the configured runtime', () => {
    for (const script of ['restart.sh', 'restart-no-cache.sh']) {
      const source = fs.readFileSync(
        path.join(projectRoot, 'local', 'shell', script),
        'utf8',
      );
      expect(source).toContain('prepare_host_mode "$HOST_MODE"');
      expect(source).not.toMatch(/^npm run build$/m);
    }

    const common = fs.readFileSync(
      path.join(projectRoot, 'local', 'shell', 'common.sh'),
      'utf8',
    );
    expect(common).not.toContain('command -v node');
    expect(common).not.toContain('{{NODE_PATH}}');
    expect(common).toContain('{{HOST_LAUNCHER}}');
    expect(common).toContain(
      'HOST_CORE_RELEASE_CLI="$ROOT_DIR/src/host-core/host-core-release-cli.ts"',
    );
    expect(common).not.toContain('bind-core');
    const activePreparation = common.match(
      /\n    active\)\n([\s\S]*?)\n      ;;/,
    )?.[1];
    expect(activePreparation).toContain('verify-active');
    expect(activePreparation).not.toMatch(/\bnpx\b|\btsx\b/);

    expect(fs.existsSync(path.join(projectRoot, 'setup', 'groups.ts'))).toBe(
      false,
    );
    const setupIndex = fs.readFileSync(
      path.join(projectRoot, 'setup', 'index.ts'),
      'utf8',
    );
    expect(setupIndex).not.toContain("'./groups.js'");
    expect(setupIndex).not.toContain('syncGroups');
  });
});
