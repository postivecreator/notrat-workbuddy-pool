/**
 * env —— 路径与环境引导（**必须在 vendor/rotakit.js 之前求值**）
 * ===========================================================
 *
 * 上游 RotaKit 是 DSH 宿主插件，它的运行期状态路径有两处会"漏"到本机其它地方：
 *
 *   1. 所有 `.workbuddy-xdpool/*` 状态文件（usage-ledger / server-errors /
 *      oauth-last / switch-sync / boot-scan / cooldowns）都挂在
 *      `process.env.DSH_HOME ?? ~/.dsh` 下 —— 装到 Notrat 里再去写 `~/.dsh`
 *      是越界。
 *   2. `REQUEST_LOG_PATH` 默认是 **`D:\dsh-rotakit\requests.jsonl`**（上游第 10055 行，
 *      注释写着 "On D: by explicit request"）—— 一个写死盘符的绝对路径。
 *
 * 两处都能靠环境变量重定向，**不需要改上游源码**：
 *   - `DSH_HOME`          → 指向本插件的数据目录
 *   - `ROTAKIT_REQUEST_LOG` → 指向本插件数据目录，或留空串以关闭落盘
 *
 * ⚠️ `REQUEST_LOG_PATH` 是上游的**模块级常量**，在 import 那一刻就定值。
 * 所以本模块必须在 `vendor/rotakit.js` 之前求值。
 * engine.js 里第一行就是 `import "./env.js";` —— ESM 规范保证导入按源码顺序
 * 深度优先求值，且 importer 主体最后执行，所以 env.js（无任何 import）一定先跑完。
 * `tests/_state_isolation.mjs` 会断言这件事真的成立，而不是靠上面的推理成立。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Notrat 的插件数据目录约定：`~/.notrat/plugins/data/<plugin-id>/` */
const NOTRAT_HOME = path.join(os.homedir(), ".notrat");
const PLUGIN_ID = "notrat-workbuddy-pool";

/** 本插件的数据根。可用 `NOTRAT_WBPOOL_HOME` 覆盖（测试与多实例用）。 */
const DATA_DIR = process.env.NOTRAT_WBPOOL_HOME
  ? path.resolve(process.env.NOTRAT_WBPOOL_HOME)
  : path.join(NOTRAT_HOME, "plugins", "data", PLUGIN_ID);

/** 上游状态文件的家：`.workbuddy-xdpool/*` 会落在这里。 */
const STATE_DIR = path.join(DATA_DIR, "state");

/** 配置文件。 */
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

/**
 * 请求日志。
 *
 * 尊重使用者的显式设置：设成空串表示"不要落盘"（上游语义：内存环形缓冲照常工作），
 * 这种情况下我们**不**覆盖它。
 */
const REQUEST_LOG_FILE = path.join(DATA_DIR, "requests.jsonl");

for (const dir of [DATA_DIR, STATE_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 建不出来时让后续写入自行报错，不要在这里抢着抛 */
  }
}

/** 上游状态文件的基座。必须在 rotakit.js 求值前设好。 */
process.env.DSH_HOME = STATE_DIR;

/** 把请求日志从 `D:\dsh-rotakit\` 拽回插件数据目录。未设置才覆盖。 */
const requestLogOverridden = process.env.ROTAKIT_REQUEST_LOG === undefined;
if (requestLogOverridden) process.env.ROTAKIT_REQUEST_LOG = REQUEST_LOG_FILE;

export const paths = {
  dataDir: DATA_DIR,
  stateDir: STATE_DIR,
  configFile: CONFIG_FILE,
  requestLogFile: REQUEST_LOG_FILE,
  /** 上游那些会落在此处的文件名，供自检脚本逐个断言。 */
  upstreamStateFiles: [
    "usage-ledger.json",
    "server-errors.json",
    "oauth-last.json",
    "switch-sync.json",
    "boot-scan.json",
    "cooldowns.json",
  ],
};

export const envBootstrap = {
  /** false 表示使用者显式关掉了请求日志落盘。 */
  requestLogOverridden,
  dshHome: process.env.DSH_HOME,
  /** 上游那条写死盘符的默认路径——自检脚本会断言它没被用到。 */
  upstreamRequestLogDefault: path.join("D:", "dsh-rotakit", "requests.jsonl"),
};

export { DATA_DIR, STATE_DIR };
