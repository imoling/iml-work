// macOS ad-hoc 签名钩子：无开发者证书时的企业内网分发方案。
//
// 为什么必须有：electron-builder 配 identity:null 会完全跳过签名，而 Apple Silicon 对
// **无签名**应用直接报「已损坏，无法打开」——右键打开都救不了，只能 xattr 清 quarantine。
// ad-hoc 签名（codesign -s -）后降级为「无法验证开发者」，右键 → 打开即可正常使用。
// 真正的根治是 Developer ID 签名 + 公证（需付费 Apple 开发者账号），有账号后替换此钩子。
const { execSync } = require('child_process')

exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  console.log(`  • ad-hoc 签名  ${appPath}`)
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
}
