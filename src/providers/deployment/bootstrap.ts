import { stringify } from 'yaml';

/** Bootstraps the compute host with its execution tooling. */
export function bootstrap(): string {
  return '#cloud-config\n' + stringify({
    package_update: true,
    packages: ['docker.io'],
    runcmd: [
      ['install', '-d', '-m', '0700', '/var/lib/ii-runtime'],
      ['systemctl', 'enable', '--now', 'docker'],
    ],
  });
}
