const fs = require('fs');
const path = require('path');

const wwwDir = path.join(__dirname, 'www');
if (!fs.existsSync(wwwDir)) {
    fs.mkdirSync(wwwDir, { recursive: true });
}

const filesToCopy = ['index.html', 'manifest.json', 'sw.js'];
filesToCopy.forEach(file => {
    const src = path.join(__dirname, file);
    const dest = path.join(wwwDir, file);
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log(`Copied ${file} -> www/${file}`);
    }
});
console.log('Build completed for Capacitor www/');

