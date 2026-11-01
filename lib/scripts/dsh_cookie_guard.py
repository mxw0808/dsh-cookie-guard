"""统计并（可选）清理 DeepSeek Harness 桌面端的 dsh-auth cookie。

背景：桌面端每次启动会换一个 127.0.0.1:<随机端口>，而认证 cookie 的名字是
    dsh-auth- + base64url(sha256(authority))
authority 含端口 → 每次启动就是一个**新名字**的新 cookie，有效期 30 天，且没有任何清理逻辑。
攒够几十条后，请求头会超过 Node 默认的 16KB 上限，启动直接失败。

用法（必须先把 DSH 完全退出，否则数据库被独占、读不到）：
    python dsh_cookie_guard.py            # 只看，不改
    python dsh_cookie_guard.py --block 40 # 超过 40 条就备份并删除 Cookies
"""

import argparse
import datetime
import os
import shutil
import sqlite3
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

COOKIES = os.path.join(
    os.environ.get("APPDATA", ""),
    "@deepseek-ai",
    "dsh-desktop",
    "Network",
    "Cookies",
)
HEADER_BUDGET = 16 * 1024


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--block", type=int, default=0, help="超过这个条数就备份并删库")
    ap.add_argument("--auto", action="store_true", help="不询问，超阈值直接备份删库（给启动器用）")
    args = ap.parse_args()
    report_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookie-report.txt")

    def log(line: str) -> None:
        """同时写屏幕和报告文件：DSH 关着的时候人看不到屏幕，报告要留得下来。"""
        print(line)
        try:
            with open(report_path, "a", encoding="utf-8") as fh:
                stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                fh.write(f"[{stamp}] {line}\n")
        except OSError:
            pass

    if not os.path.exists(COOKIES):
        log(f"找不到 cookie 数据库：{COOKIES}")
        log("（如果 DSH 从没启动过，这是正常的）")
        return 0

    tmp = os.path.join(os.environ.get("TEMP", "."), "dsh_cookies_read.db")
    try:
        shutil.copyfile(COOKIES, tmp)
    except PermissionError:
        log("读不到：数据库正被 DSH 独占（说明 DSH 还开着）。")
        log("请先从托盘完全退出 DeepSeek Harness，再运行。")
        return 2

    con = sqlite3.connect(tmp)
    cur = con.cursor()
    cur.execute("select name, length(value), length(encrypted_value) from cookies")
    rows = cur.fetchall()
    con.close()
    os.remove(tmp)

    auth = [(n, (a or 0) + (b or 0)) for n, a, b in rows if n.lower().startswith("dsh-auth-")]
    total = sum(size + len(name) + 2 for name, size in auth)
    log(f"cookie 总数        : {len(rows)}")
    log(f"dsh-auth-* 条数     : {len(auth)}")
    log(f"这些 cookie 约占头  : {total} B / {HEADER_BUDGET} B ({total / HEADER_BUDGET:.0%})")
    if auth:
        biggest = max(auth, key=lambda x: x[1])
        log(f"单条最大           : {biggest[1]} B")
    if total > HEADER_BUDGET * 0.6:
        log("⚠ 已经过半，建议尽快清理。")
    elif len(auth) >= 20:
        log("提醒：条数不少了，30 天有效期一过才会自然消失，清理更保险。")

    if args.block and len(auth) > args.block and not args.auto:
        ap_ok = input(f"\n超过 {args.block} 条，是否备份并删除 Cookies？（y/N）").strip().lower()
        if ap_ok != "y":
            log("已取消，未做任何改动。")
            return 0

    if args.block and len(auth) > args.block:
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = f"{COOKIES}.bak-{stamp}"
        shutil.move(COOKIES, backup)
        log(f"已备份到：{backup}")
        log("重启 DSH 后会自动重建一个新的 Cookies（只需重新登录一次）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
