# Team AI Box 离线安装包

自研代码许可证见包内 `LICENSE`；第三方保持原许可，详见 `THIRD_PARTY_NOTICES.md`
和 `docs/open-source/components.json`。MIT 不授予 Google 服务、Windows、模型权重
或第三方品牌的额外分发权。本包的文件完整性检查不等于所有组件已经获得分发授权。

本包用于尚未安装 Team AI Box、保留兼容原厂 Linux 系统的 DGX Spark。
复用已有 Docker、Compose 和 NVIDIA GPU 环境，不重装它们，不格式化系统盘。

## 使用

先用发行包旁的 `.sha256` 文件校验归档，再解包：

```sh
sha256sum -c teamaibox-<发行号>-linux-arm64.tar.sha256
tar -xf teamaibox-<发行号>-linux-arm64.tar
cd teamaibox-<发行号>-linux-arm64
sudo ./install.sh
```

正常安装不需要公网，不需要编辑环境变量。安装器补齐包内必要工具，
生成本机独立配置，初始化全新的数据库并启动服务。模型首次加载可能耗时，
进度中的“加载中”不表示完整安装已经成功。

可先运行 `sudo ./install.sh --check`，只校验环境和包，不安装。
`./install.sh --verify-package` 仅校验包内容，也可在打包工作站运行。
可用 `--installation-root /专用路径/installation` 指定新安装根；不能指向旧数据目录。

## 中断与现有数据

失败或中断后，解决报告中的具体问题，再运行原命令继续，不要删除安装目录。
安装器保留本次生成的身份和数据。已有完整同版本安装重复执行只核对状态；
其他版本使用正式升级流程，不通过清空重装处理。安装器没有强制覆盖选项。

## 首次使用

使用盒子当前 IP 的 HTTPS 地址打开网页，直接登录：

- 管理员用户名：`admin`
- 初始密码：`admin`

安装器自动创建这一个管理员，不需要提取设置 token 或手动注册。
初始密码公开且简单，建议交付使用前在用户管理中修改。
普通用户没有默认账号，由管理员创建。
此规则只用于空白账号库；续装、重跑、重启和升级不会把已有账号或密码改回默认值。
管理员恢复码独立生成，保存在安装根的 `secrets/initial-owner-recovery.json`（仅 root 可读）；
不要将恢复码发到聊天、工单或公共日志。已有安装不生成或替换恢复码。
本机签发的 HTTPS 证书需要按照管理员提供的 CA 信任说明配置浏览器；
证书包含名称不代表局域网一定提供该名称的 DNS/mDNS 解析。
本机 CA 公钥证书默认在 `/srv/teamaibox/installation/https/ca.crt`，
只分发这一份公钥证书；不要复制同目录私钥。

平台安装不包含现有虚拟机、Google 登录状态或用户文件。
Windows/Linux ISO 由使用者上传或从网盘选择后自行安装。
Google Play 和外部 API 本身需要互联网；这些服务不属于“可离线访问”的承诺。

组件许可文件随对应发行资源保留。Copyright © Weerocks LLC。
联系：teamaibox@weerocks.llc。
