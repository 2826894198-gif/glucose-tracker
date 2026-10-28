'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const esbuild = require('esbuild');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function buildCloudPackages(root, names) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length ||
      names.some(name => !['glucose', 'recognize'].includes(name))) {
    throw new Error('只允许打包本工程的 glucose 和 recognize 云函数。');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glucose-cloud-bundle-'));
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const functions = [];
    for (const name of names) {
      const source = path.join(root, 'cloudfunctions', name);
      const destination = path.join(directory, name);
      fs.mkdirSync(destination);
      // DevTools 2.01.2510290 rejected both ordinary and staged node_modules
      // trees with EISDIR. A flat bundle was actually accepted by the same CLI.
      // Bundle the already verified local dependencies; never reinstall in cloud.
      const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: [path.join(source, 'index.js')],
        outfile: path.join(destination, 'index.js'),
        bundle: true, platform: 'node', target: 'node16.13', format: 'cjs',
        metafile: true, logLevel: 'silent',
      });
      if (result.warnings.length) throw new Error(`${name} 云函数打包有未处理的依赖警告，已停止。`);
      const inputs = {};
      for (const relative of Object.keys(result.metafile.inputs)) {
        const file = path.resolve(root, relative);
        if (!file.startsWith(source + path.sep)) throw new Error('云函数包含目录外来源，已停止。');
        inputs[path.relative(source, file).split(path.sep).join('/')] = digest(fs.readFileSync(file));
      }
      fs.copyFileSync(path.join(source, 'config.json'), path.join(destination, 'config.json'));
      const original = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
      fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
        name, version: original.version, private: true, main: 'index.js', engines: { node: '>=16.13' },
      }, null, 2) + '\n');
      const files = Object.fromEntries(['index.js', 'config.json', 'package.json'].map(file => {
        const bytes = fs.readFileSync(path.join(destination, file));
        return [file, { bytes: bytes.length, sha256: digest(bytes) }];
      }));
      functions.push({ name, path: destination, files, sourceInputs: inputs,
        lockfileSha256: digest(fs.readFileSync(path.join(source, 'package-lock.json'))) });
    }
    return { directory, functions, cleanup };
  } catch (error) { cleanup(); throw error; }
}

module.exports = { buildCloudPackages };
