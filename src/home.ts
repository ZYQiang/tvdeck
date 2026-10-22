import path from 'node:path';

/// 两件事以前都是写死的 process.cwd()，对「在本机跑个网页」够用，
/// 但一旦做成跨终端的客户端就站不住了：
///   1. 数据（录像、上传临时文件、档案、还原快照）不该跟着工作目录跑，
///      打包后的进程 cwd 是不是项目目录全看启动方式，换一次就"数据全没了"；
///   2. 代码资源（public/、tools/）在客户端里是在应用包内，不在 cwd。
/// 所以各留一个显式出口。默认值和以前完全一致，老数据不用搬家；
/// 客户端启动后端时把这两个变量指过去即可。

/// 数据目录：默认 <项目目录>/.tvdeck。
/// 客户端侧建议指到系统用户数据目录：
///   macOS  ~/Library/Application Support/TVDeck
///   Windows %APPDATA%\TVDeck
///   Linux  ${XDG_DATA_HOME:-~/.local/share}/tvdeck
export const TV_HOME = (() => {
  const env = (process.env.TVDECK_HOME || '').trim();
  return env ? path.resolve(env) : path.join(process.cwd(), '.tvdeck');
})();

/// 代码资源根：默认 <项目目录>，public/ 和 tools/ 都从这里找
export const APP_ROOT = (() => {
  const env = (process.env.TVDECK_APP_ROOT || '').trim();
  return env ? path.resolve(env) : process.cwd();
})();

/// 数据目录下的某个子项，省得各处再拼一次 '.tvdeck'
export const under = (...parts: string[]): string => path.join(TV_HOME, ...parts);
