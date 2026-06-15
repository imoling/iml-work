const { app, BrowserWindow } = require('electron')
const path = require('path'); const fs = require('fs')
const INDEX = path.join(__dirname, '..', 'dist', 'index.html')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const clickText = (sel, text) => `(function(){var b=[].slice.call(document.querySelectorAll('${sel}')).find(function(x){return x.textContent.indexOf('${text}')>=0}); if(b){b.click();return true} return false})()`
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { preload: path.join(__dirname, 'stub-preload.cjs') } })
  await win.loadFile(INDEX); await wait(900)
  await win.webContents.executeJavaScript("var b=document.querySelector('.claim-footer .settings-btn'); b&&b.click()"); await wait(1300)
  await win.webContents.executeJavaScript(clickText('.sidebar-item', '设置')); await wait(700)
  console.log('tab:', await win.webContents.executeJavaScript(clickText('.settings-tab', '企业系统连接'))); await wait(900)
  const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, 'shot-systems.png'), img.toPNG())
  console.log('captured'); app.quit()
}).catch((e) => { console.error(e); app.quit() })
