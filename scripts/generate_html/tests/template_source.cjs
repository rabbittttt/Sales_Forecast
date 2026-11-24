// Exercise the same ordered sections embedded by core/template_assets.py.
const fs = require('node:fs');
const path = require('node:path');

exports.readTemplate = function readTemplate(entry) {
  const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return read(entry).replace(/^\/\* @include ([\w-]+\.(?:js|css)) \*\/$/gm, (_, name) =>
    read(path.join(path.dirname(entry), name)).replace(/\n$/, ''));
};
