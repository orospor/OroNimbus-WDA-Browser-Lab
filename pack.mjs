import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.dirname(fileURLToPath(import.meta.url));
const arch = process.argv[2] ?? process.arch;
const supported = new Set(['ia32', 'arm64', 'x64']);
if (!supported.has(arch)) {
  throw new Error(`Unsupported target architecture: ${arch}`);
}

const addonSource = path.join(root, 'build', 'Release', 'wda_native.node');
const addonDirectory = path.join(root, 'app', 'native');
if (!fs.existsSync(addonSource)) {
  throw new Error(`Native addon missing: ${addonSource}`);
}
fs.mkdirSync(addonDirectory, { recursive: true });
fs.copyFileSync(addonSource, path.join(addonDirectory, 'wda_native.node'));
// A byte-identical copy with a distinct path is never required as an addon. It
// exists only so the running lab can prove that CIG rejects a new unsigned image
// load after policy activation; without CIG the same load must succeed and free.
fs.copyFileSync(addonSource, path.join(addonDirectory, 'cig_probe_unsigned.node'));

const output = path.join(root, 'dist');
await packager({
  dir: path.join(root, 'app'),
  out: output,
  name: 'OroNimbus',
  executableName: 'OroNimbus',
  platform: 'win32',
  arch,
  electronVersion: '43.4.1',
  overwrite: true,
  prune: true,
  asar: { unpack: '**/*.node' },
  win32metadata: {
    CompanyName: 'OroResea Research Lab',
    FileDescription: 'OroNimbus controlled Electron WDA browser fixture',
    InternalName: 'OroNimbus',
    OriginalFilename: 'OroNimbus.exe',
    ProductName: 'OroNimbus',
  },
});

console.log(path.join(output, `OroNimbus-win32-${arch}`));
