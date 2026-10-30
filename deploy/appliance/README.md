# 单盒安装

产品只安装在一台 ARM64 盒子中。`production.compose.yaml` 合并以下配置：

- `../compose/core.yaml`：数据库、消息、对象、调度、Agent、软件源和 Web。
- `compose.yaml`：HTTPS、加密数据目录和本机控制服务。
- `applications.compose.yaml`：办公应用、虚拟手机、Windows 和无线投屏的网页及 API。
- `protected-office.compose.yaml`：六项常驻办公模型和本机维护策略。
- `maintenance.compose.yaml`：本机维护及升级回退。

虚拟手机、Windows、模型 Worker 和投屏接收器按操作由本机 Agent 启动，不再使用远端安装器。Google Play 保留独立 ROM 选项；两种 Android 均使用本机虚拟摄像头。投屏只有浏览器输出。

## 安装配置

镜像不包含测试账号、实验盒 IP、远端清单或测试策略。从 `appliance.env.example` 开始，提供镜像、持久 UUID、已挂载的加密数据根目录和密钥路径。升级复用 UUID、证书和数据目录，不重新创建手机或电脑。

本机控制服务使用本次安装的应用入口、模型内部网和手机控制网。正式入口见[本机安装与升级](../../docs/operations/portable-installation.md)：`appliance_setup.py prepare` 在 Compose 前创建或验证网络，将实际名称写入 `networks.env`。旧安装明确导入原网络 ID 后复用，不依赖开发盒已有的网络名，不修改路由或重建虚拟机。

`TEAMAIBOX_APPLIANCE_PUBLIC_CONFIG_DIR` 为只读配置目录，包含 `ca.crt`、`node.crt`、`scheduler.crt`、`gateway.crt`、`maintenance.crt`、`node.json`、`maintenance-controller.json` 和 `plugin-routes.json`。可从本目录复制最后一项。私钥通过 Compose secrets 提供，不放进网页镜像或提交仓库。

`TEAMAIBOX_APPLIANCE_RUNTIME_ENV_FILE` 提供本次安装的模型、插件、虚拟机和投屏配置，不能用空文件代替。保留 `PLATFORM_VIRTUAL_PHONES_ENABLED`、本机 `PLATFORM_VIRTUAL_PHONE_NODES_JSON`、两个 ROM 的 `PLATFORM_VIRTUAL_PHONE_SYSTEM_RELEASES_JSON`、摄像头开关、`PLATFORM_VIRTUAL_COMPUTERS_CONFIG_JSON`、投屏资源/回调及 Agent/插件运行配置。手机和 Windows 只能指向同一 `PLATFORM_APPLIANCE_NODE_ID`。Agent 的池、ROM、Windows 磁盘和摄像头路径继续来自本机清单。

本地安装时生成证书，升级沿用有效证书，不运行在线 CA 签发服务。Agent 和本机网关共享 API 网络空间，只监听 `127.0.0.1:9443` 和 `127.0.0.1:9444`；维护服务只监听 `127.0.0.1:9446`。这些端口不发布给局域网，浏览器仍用 HTTPS。

### 网络地址自动适配

单盒启用 `WEB_AUTO_LOCAL_ADDRESS=true`。`WEB_PUBLIC_ORIGIN` 与 API 的 public origin 是一致的内部请求校验基准，不再是浏览器必须使用的 IP；换网时不修改它们。Web 先用当前证书 SAN 校验请求 Host，并要求 Origin 与浏览器访问地址严格同源，随后才转换为内部校验基准；不是放开任意来源或信任浏览器传来的 Forwarded 头。

宿主机安装 `tools/appliance_network_identity.py` 到 `/usr/local/lib/teamaibox/`，安装同目录下 `teamaibox-network-identity.service` 和 `.timer` 到 systemd，并启用 timer。由安装器创建 root 所有、不可被普通用户写入的 `/etc/teamaibox/network-identity.json`：

```json
{
  "tlsDirectory": "/installation-specific/persistent-https",
  "installationFile": "/etc/teamaibox/installation.json",
  "dnsNames": ["teamaibox.local"],
  "publicStateFile": "/installation-specific/public-config/appliance-addresses.json",
  "sfuConfig": "/installation-specific/sfu/sfu.yaml"
}
```

这里的路径和容器名取本次安装的已有资源，**不填写 IP**。`tlsDirectory` 保留已有 `web.key`、`ca.crt`、`ca.key`、`web.crt`；CA 私钥须仅 root 可读。Web 挂载整个目录为只读以读取原子替换后的证书，不再使用固定文件 inode 的证书 bind。`publicStateFile` 位于 API 已挂载的公共配置目录，内容只有地址和本地主机名，不含密钥。API 的 `PLATFORM_APPLIANCE_ADDRESSES_FILE` 指向它在容器内的路径。

每 15 秒检查实际物理网卡/Wi-Fi/bond 的当前地址，排除 Docker/VPN/loopback 地址；默认路由的物理网卡地址优先。地址变化或证书即将到期时，以原 CA 和原私钥签发新叶证书，通过 SIGHUP 热加载并核对健康接口中的指纹。临时断网保留证书，公共可用地址置空；恢复联网后继续自动处理。无需重建 API、数据库、手机或电脑。

投屏网页的认证连接跟随当前网页地址。SFU 的媒体地址只在实际主地址/网卡变化时重载该转发服务，因为其 ICE 地址在进程启动时确定；不重启 Docker 或 guest。正在使用的网络连接不能在换网时无缝保持，重新连接即可，不承诺网络切换中不中断。

使用新 IP 访问可能需要重新登录：浏览器不会把旧 IP 的 Cookie 自动交给新 IP，这是正常隔离，并非需要重新设置盒子。支持 mDNS 的局域网可使用设备的 `<hostname>.local`；不保证被网络禁止的 mDNS 自动可达，也不把证书里的别名等同于 DNS 已发布。

维护配置只包含一个 `endpoint: {host: "127.0.0.1", port: 9446, serverName: "localhost"}`，没有节点列表或滚动升级。serverName 必须与证书匹配。

升级后保留的旧容器不是现行服务。安装配置可用 `TEAMAIBOX_METRIC_RETIRED_CORE_SERVICES` 明确列出已退役的服务名，逗号分隔；新安装留空。只有已退出的对应容器不再进入当前核心服务健康列表，仍在运行、卡在删除/重启中或其他未退役服务的故障不会被隐藏。历史告警保留；不要用此项掩盖仍需运行的服务。

受保护办公应用仍使用原来的六个 Worker 与模型档案。`LOCAL_OPENAI_PROFILE_ID`、`LOCAL_OPENAI_PROFILE_KEY` 及其他本次安装的模型配置须保留精确值，不能生成新身份代替现有实例。应用目录通过本机 `appliance.inspect` 读取 Agent 当前已安装的保护目标策略和容器身份；策略摘要由 `TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST` 同时绑定 API 和 Agent。身份、当前节点代次、模型/镜像/配置或策略不一致时显示不可用，不能以数据库旧健康记录代替实时检查。维护、事务恢复和重启保护仍由原有本机策略及持久日志执行。

正常启动不需要历史 v5 bundle、probe 凭据、生产场景边界或验收控制接口。安装环境不能携带 `PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID`、`*_BUNDLE_*`、`*_DEPLOYMENT_PLAN_FILE`、`*_PROBE_*` 等历史验收变量；单机入口会明确拒绝，而不会静默启用旧多设备验收链。历史计划、验证器和失败证据保持原样。本配置分离不是新设备冷启动、完整恢复或新版部署通过的证据。

## 开机恢复

六个办公 Worker 的 ID 从安装配置读取，不再写死为开发机器上的 ID。现有设备升级必须保留原 ID；更新网页不替换模型容器或客户机磁盘。

开机仍复用 `restore_calibrated_office_workers_v3.py` 及同目录依赖（包括 `boot_container_memory.py`），不增加另一套恢复服务。部署时使用打包脚本完整复制依赖，不能仅替换入口脚本。宿主机的现有办公恢复 systemd 服务须加载包含 `PLATFORM_APPLIANCE_NODE_ID` 和 `TEAMAIBOX_POSTGRES_CONTAINER` 的本机环境文件；两项缺失或设备身份不一致都会在启动模型前报错。数据库名称必须是本机已有 PostgreSQL 容器，不接受远端地址。

用 `--configuration` 指定原来的办公资源配置，`--manifest` 指定原来的容器清单；不指定后者时沿用现有安装路径。先用 `--check` 只读检查，确认六项模型身份、资源预算和数据库均正确，再更新现有服务的脚本路径及环境文件。保留数据库、加密数据盘就绪后才恢复模型的启动顺序。不创建第二个恢复服务，不同时运行新旧脚本，也不以清单生成新模型容器。真正断电后的恢复仍需在部署验收时确认，单元测试不能替代它。

## 数据与部署

`TEAMAIBOX_DATA_ROOT` 必须是已挂载的加密文件系统，参见 `deploy/storage/appliance-storage-layout.v1.json`。Compose 不格式化、不解锁、不挂载磁盘。安装前建立子目录和服务 UID 权限。数据库、对象和客户机磁盘保留在原目录；普通 Docker 镜像层不得存放用户数据。

选择文件池时，存储和启动恢复工具均使用[本机维护计划](../android/cuttlefish/local-storage-maintenance.md)，密钥只从同机已挂载的加密目录读取。旧双机计划不会被静默复用，也不会因此重新格式化已有池。

先检查配置，再执行明确的部署操作：

```sh
docker compose --env-file /etc/teamaibox/installation.env --env-file /etc/teamaibox/networks.env -f deploy/appliance/production.compose.yaml config --quiet
```

部署使用上述中性入口；`deploy/application-catalog-e2e` 中的日期化材料仅为旧验证材料，不再是产品安装入口。本次定向部署与验收见[六类交付风险修复](../../docs/validation/portable-appliance-delivery-20261024.md)，不重开已完成的业务测试。
