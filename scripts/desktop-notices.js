import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function writeDesktopNotices(root, target) {
  const nodeLicense = process.env.NODE_LICENSE_PATH || path.join(path.dirname(process.execPath), 'LICENSE');
  if (!fs.existsSync(nodeLicense))
    throw Error('No se encontró la licencia de Node. Indicá NODE_LICENSE_PATH con el archivo LICENSE de tu distribución de Node.');
  fs.copyFileSync(nodeLicense, path.join(target, 'LICENSE-Node.txt'));
  const host = execFileSync('rustc',['-vV'],{encoding:'utf8',windowsHide:true}).match(/^host:\s*(\S+)/m)?.[1];
  if(!host) throw Error('No se pudo identificar la plataforma de Rust.');
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--offline', '--filter-platform', process.env.CARGO_BUILD_TARGET || host, '--format-version', '1', '--manifest-path', path.join(root,'src-tauri','Cargo.toml')], {encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true}));
  const sections = ['Third-party Rust dependency notices. Node notices are in LICENSE-Node.txt; JavaScript dependency licenses are included in node_modules.'];
  for (const pkg of metadata.packages.filter(p=>p.source).sort((a,b)=>a.name.localeCompare(b.name))) {
    const dir = path.dirname(pkg.manifest_path);
    const names = new Set(fs.readdirSync(dir).filter(name=>/^(LICENSE|LICENCE|COPYING|NOTICE)([._-]|$)/i.test(name)));
    if(pkg.license_file) names.add(pkg.license_file);
    const texts = [];
    for (const name of names) {
      const file = path.resolve(dir,name);
      if(fs.existsSync(file) && fs.statSync(file).isFile()) texts.push(`${path.basename(name)}\n${fs.readFileSync(file,'utf8')}`);
    }
    sections.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license || 'See included license'}\n\n${texts.join('\n\n')}`);
  }
  fs.writeFileSync(path.join(target,'THIRD-PARTY-LICENSES.txt'),sections.join('\n'));
}
