const fs = require('fs');
const path = require('path');

function patchFile(filePath, replacements) {
  let content = fs.readFileSync(filePath, 'utf8');
  for (const { search, replace } of replacements) {
    content = content.split(search).join(replace);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Patched ${filePath}`);
}

const editorJs = path.join(__dirname, 'editor', 'scripts', 'h5peditor.js');
patchFile(editorJs, [
  { search: 'window.parent.H5PEditor', replace: '(function(){try{return window.parent.H5PEditor;}catch(e){return undefined;}})()' },
  { search: 'window.parent.H5PIntegration', replace: '(function(){try{return window.parent.H5PIntegration;}catch(e){return undefined;}})()' }
]);

const coreJs = path.join(__dirname, 'core', 'js', 'h5p.js');
patchFile(coreJs, [
  { search: 'window.parent.H5P.', replace: '(function(){try{return window.parent.H5P;}catch(e){return {};}})().' },
  { search: 'window.parent.H5PIntegration', replace: '(function(){try{return window.parent.H5PIntegration;}catch(e){return undefined;}})()' }
]);
