const H5P = require('@lumieducation/h5p-server');
const h5pEditor = new H5P.H5PEditor({}, {}, {}, {}, {});
console.log(h5pEditor.packageImporter);
