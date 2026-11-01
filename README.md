# dsh-cookie-guard

给 Windows 上的 DeepSeek Harness 用的一只小保险：**每周检查一次 `dsh-auth-*` cookie 的数量，超过阈值就备份并清掉**，清理这件事做成插件列表里的一个开关。

## 备注：它到底做什么

一句话：**它是 DSH 的 cookie 体检员，只在数量真的过分时才动手，动手前先备份。**

具体到行为：

- **它盯着什么**：`%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` 这个 SQLite 库里名字以 `dsh-auth-` 开头的行。这些是 DSH 每次启动新发一条的登录凭证，一条约 227 字节。
- **什么时候看**：每周一 12:00 由 Windows 计划任务触发。如果那一刻 DSH 正开着，它会每 5 分钟探一次、最多等 3 小时，等你关掉再干活——因为 DSH 运行时会独占这个库文件，读不了。
- **什么算「过分」**：默认 **40 条**（约 9 KB，吃掉请求头上限的 55%）。到这条线就地清理，不必等到真的崩。
- **它动手做什么**：先把整个库复制一份 `Cookies.bak-<时间戳>`，再删掉那批 `dsh-auth-*` 行。**其它 cookie 一条不碰**。
- **没到线做什么**：什么都不做，只往 `cookie-report.txt` 追加一行数据（时间、总数、条数、占用字节）。
- **插件开关是什么意思**：在应用里停用这个插件，周一那次就只写一行 `nothing to do` 然后退出，一条 cookie 都不删；重新启用就恢复。开关状态读的是 profile 的 `dsh.profile.bundles`，不是插件内部的状态。
- **失败了会怎样**：库被占用（DSH 没关）、Python 找不到、库不存在——任何一种都只是记日志并返回非零退出码，**不会删任何东西**，等下周再试。
- **它不做什么**：不联网、不上传、不改 DSH 配置、不动站点数据、不碰 `localStorage` / 会话文件。

## 为什么需要它

DSH 桌面端每次启动都会监听一个**随机的回环端口**，而它的登录 cookie 名字是 `sha256(主机:端口)` 算出来的：

```js
function cookieName(authority) {
  return COOKIE_PREFIX + encodeBase64Url(createHash("sha256").update(authority).digest());
}
```

于是每次启动都会多出一条**新名字**的 `dsh-auth-*` cookie，30 天有效，没有人清理它们。一条约 227 字节，而浏览器对单个站的请求头有 16 KB 的软上限——**大约 72 条就顶到头**，届时请求头超限，应用会起不来或页面白屏：这就是流传的「第 72 次打开必崩」。

实测数据（11 天、51 次启动）：

```
cookie 总数        : 51
dsh-auth-* 条数     : 51
这些 cookie 约占头  : 11577 B / 16384 B (71%)
单条最大           : 173 B
```

按这个速度，一个多月就会到 130 条往上，远不止 72。

## 三个组成部分

| 文件 | 作用 |
|---|---|
| `lib/index.js` + `cordis.patch.yml` | 插件本体。加载时 `schtasks /Change /TN "DSH Cookie Weekly Check" /ENABLE`，卸载时 `/DISABLE`，并往 `last-load.json` 写一条「宿主确实加载了」的证据 |
| `scripts/dsh_cookie_guard.py` | 真正的干活脚本：把 `Network\Cookies` 复制到临时目录后用 sqlite 统计、`--block N` 超阈值时先备份再删 `dsh-auth-*` |
| `scripts/dsh_cookie_weekly.ps1` | 计划任务调它：先看插件在不在启用列表里；在的话每 5 分钟探一次 DSH 是否关闭（最多 3 小时），关了就调 guard |

**开关逻辑**：插件在 `dsh.profile.bundles` 里 → 周任务照跑；移出去 → 周任务写一行 `nothing to do` 直接退出。就算插件的 `apply` 没被执行到，开关依然有效，因为真正的判据在周任务脚本里。

## 安装

### 1. 把脚本放到固定位置

```
mkdir %USERPROFILE%\.dsh\tools
copy scripts\*.py  %USERPROFILE%\.dsh\tools\
copy scripts\*.ps1 %USERPROFILE%\.dsh\tools\
```

### 2. 注册计划任务

在**普通 PowerShell**（不需要管理员）里执行：

```powershell
$ps = "$env:USERPROFILE\.dsh\tools\dsh_cookie_weekly.ps1"
schtasks /Create /TN "DSH Cookie Weekly Check" /SC WEEKLY /D MON /ST 12:00 `
  /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps`"" `
  /F
```

### 3. 装插件

```powershell
git clone https://github.com/mxw0808/dsh-cookie-guard.git
dsh plugin --profile desktop add ./dsh-cookie-guard
```

没装 git 也没关系：在仓库页点 **Code ▾ → Download ZIP**，解压后把解压出来的目录路径交给同一条命令（`dsh plugin --profile desktop add <解压出来的目录>`），效果一样。

桌面端的 `desktop` profile 由 Electron 应用独占管理，命令行写不进去时用**应用内 设置 → 插件**安装。装完完全退出应用再打开。
```

桌面端的 `desktop` profile 由 Electron 应用独占管理，命令行写不进去时用**应用内 设置 → 插件**安装。装完完全退出应用再打开。

### 4. 手动跑一次（可选）

```
python %USERPROFILE%\.dsh\tools\dsh_cookie_guard.py
```

不带参数只体检、不动手；`--block 40` 是「超过 40 条就清理」。

## 验证是否生效

`scripts` 会往同目录写两个日志：

- `cookie-weekly.log`：周任务的执行时间线
- `cookie-report.txt`：每次体检的数据（时间戳 + 条数 + 占用字节）

`nothing to do` = 插件处于停用状态；`attempt 1: DSH is closed, running guard` = 正在干活。

## 已知限制

- 只在 **Windows** 上工作（依赖 `schtasks`、`%APPDATA%` 下的 Chromium 库）。
- 计划任务名**固定**为 `DSH Cookie Weekly Check`，改任务名要同时改 `lib/index.js` 里的 `TASK_NAME`。
- profile 名**固定**为 `desktop`（`lib/index.js` 与 ps1 里都写死了），用 `web` profile 需要改两处。
- guard 需要 **Python 3.8+**；ps1 会优先用 DSH 自带的 python，找不到才退回系统 `python`。
- 删除前会先备份整库到 `Cookies.bak-<时间戳>`，这些东西可以定期手工清掉。

## 许可

MIT。
