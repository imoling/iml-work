// Rasterize brand SVGs to PNG via Chromium.
// env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron tools/render-icons.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const DIR = path.join(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'brand')

function pageHtml(svg, size, transparent) {
  const bg = transparent ? 'transparent' : '#fff'
  // Force the inline SVG to fill the capture box.
  const sized = svg.replace(/<svg /, `<svg width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" `)
  return `<!doctype html><meta charset=utf8><body style="margin:0;width:${size}px;height:${size}px;background:${bg}">${sized}</body>`
}

function render(html, size) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, backgroundColor: '#00000000' })
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      try { const img = await win.webContents.capturePage(); win.close(); resolve(img.toPNG()) } catch (e) { reject(e) }
    }, 350))
  })
}

app.whenReady().then(async () => {
  const appIcon = fs.readFileSync(path.join(DIR, 'app-icon.svg'), 'utf8')
  const mark = fs.readFileSync(path.join(DIR, 'logo-mark.svg'), 'utf8')
  const jobs = [
    ['app-icon.png', appIcon, 1024, false],
    ['favicon.png', appIcon, 256, false],
    ['tray-icon.png', mark, 64, true],
  ]
  for (const [name, svg, size, transparent] of jobs) {
    const png = await render(pageHtml(svg, size, transparent), size)
    fs.writeFileSync(path.join(DIR, name), png)
    console.log('wrote', name, size)
  }
  app.quit()
}).catch((e) => { console.error(e); app.quit() })
