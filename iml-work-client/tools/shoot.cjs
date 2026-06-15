const { app, BrowserWindow } = require('electron')
const path = require('path'); const fs = require('fs')
const INDEX = path.join(__dirname, '..', 'dist', 'index.html')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const clickText = (sel, text) => `(function(){var b=[].slice.call(document.querySelectorAll('${sel}')).find(function(x){return x.textContent.indexOf('${text}')>=0}); if(b){b.click();return true} return false})()`
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { preload: path.join(__dirname, 'stub-preload.cjs') } })
  await win.loadFile(INDEX); await wait(900)
  await win.webContents.executeJavaScript("var b=document.querySelector('.claim-footer .settings-btn'); b&&b.click()"); await wait(1300)
  // default tab = workbench
  console.log('open skills:', await win.webContents.executeJavaScript(clickText('.wb-tool', '业务技能'))); await wait(500)
  let img = await win.webContents.capturePage(); fs.writeFileSync(path.join(__dirname, 'shot-wb-skills.png'), img.toPNG())
  console.log('captured'); app.quit()
}).catch((e) => { console.error(e); app.quit() })
