# 单盒安装与升级：本机配置入口

本入口取代日期化的开发盒部署脚本。它不格式化磁盘、不初始化已有数据库、不替换客户机、不复制开发盒账户或密钥。历史脚本和 `.local.json` 是历史/操作者材料，不属于发行输入。

## 配置边界

`/etc/teamaibox/installation.json`（root，0600）只保存：

- `installationId` / `nodeId`：本机持久身份，升级保留。
- `services`：角色对应的精确容器 ID、镜像 ID、归属标签；不按相似名称猜测。
- `references`：公共地址、手机配置、TLS、启动恢复、存储、环境文件和基线的绝对路径；不保存密钥内容。
- `networks`：本机三个内部网络的名称、ID、隔离属性和地址段。手机控制网名称由安装身份生成；`plugin-ingress`、`compute-internal` 是现有运行时的逻辑角色约定，保留名称但在本机创建并登记独立 ID/归属，不要求开发盒预先提供。已有网络明确导入后复用。

新机不能复制另一台的这个文件。旧布局可保持原路径，不要求搬迁数据来符合示例目录。运行时 LAN 地址单独写入公共地址文件；手机的媒体状态只有转发规则成功应用后才标为可用。

## 新安装

完整离线包首次安装自动创建管理员 `admin / admin`，不创建普通用户；建议交付使用前修改初始密码。已有安装的账号和密码不因重跑、重启或升级而改变。

全新 DGX Spark 的客户入口为完整离线包内的 `sudo ./install.sh`，不再要求客户逐份填写开发环境配置。包的制作、离线预检、续装及验证状态见 [install/README.md](../../install/README.md) 和 [安装专项记录](../validation/offline-installer-20261024.md)。复用现有 Docker/NVIDIA；Windows/Linux 安装介质由用户提供。离线安装不意味着 Google、在线软件源等外部服务可以断网访问。

下面是离线安装器所复用的底层维护接口，供运维处理显式配置，不是客户首次安装步骤，也不能代替完整发行包。以下命令在目标 ARM64 盒子上，以发行包根目录为工作目录执行。须先准备已挂载的加密数据卷、模型/ROM/插件配置和摘要固定的 ARM64 镜像；不得在已有业务盒上执行新安装来验证它。

```sh
sudo python3 tools/appliance_setup.py --installation /etc/teamaibox/installation.json init --root /srv/teamaibox/installation
sudo python3 tools/appliance_https.py init --directory /srv/teamaibox/installation/https --web-gid 1000
```

`init` 生成本机独立身份及独立服务随机因子。已有文件保持原样；不完整 TLS 身份会报错，不能覆盖重建。`1000` 是当前正式 Compose 声明的 Web 组；不同发行镜像须使用其声明的 Web 组。CA 私钥仅 root 可读，Web 只读叶证书私钥。内部服务 mTLS 配置仍按发行包的角色配置提供，不能拿开发证书充当客户配置。

填写 `deploy/appliance/appliance.env.example` 对应的 `/etc/teamaibox/installation.env`：使用刚生成的 nodeId、当前数据根、每个服务/模型的本机配置和密钥引用。将三个内部网络变量留给生成的 `networks.env` 覆盖。运行环境文件仍必须完整，不能用空文件或开发 `.local.json` 凑数。

虚拟设备配置目录由 `TEAMAIBOX_GUEST_CONFIG_DIR` 提供，内含本机 `phones.json` / `computers.json`。数据、控制、安装介质、固件/策略及存储辅助进程 socket 目录分别由六个 `TEAMAIBOX_GUEST_*` 字段显式挂载；宿主与 Agent 路径保持一致，配置目录则统一映射到 `/run/config/guests`。配置使用本机 nodeId、poolId、实际网络 ID 和已安装 ROM/固件，不得复制开发池配置。发行入口检查挂载源已存在，不自动创建空目录冒充数据盘。

登记 `/etc/teamaibox/storage-volumes.json`，版本为 1，`volumes` 中每项明确包含 `source`、`keyFile`、`mountPoint`、`mapper`、`kind`（file/block）、`luksUuid`、`fsUuid`、`minimumSize`、`mountOptions`。块设备用 `/dev/disk/by-id/…` 等稳定标识；文件池记录原文件。两种均沿用原 64 字节自动解锁因子和 slot 0，不新建密钥。`minimumSize` 是防截断下界，不是容量上限。真实产品数据卷清单不得为空。

```sh
sudo python3 tools/appliance_setup.py --installation /etc/teamaibox/installation.json prepare \
  --env-file /etc/teamaibox/installation.env --compose deploy/appliance/production.compose.yaml \
  --contract deploy/host/release-compatibility.v1.json --storage-configuration /etc/teamaibox/storage-volumes.json
sudo python3 tools/appliance_setup.py --installation /etc/teamaibox/installation.json apply \
  --env-file /etc/teamaibox/installation.env --compose deploy/appliance/production.compose.yaml \
  --contract deploy/host/release-compatibility.v1.json --storage-configuration /etc/teamaibox/storage-volumes.json \
  --role platform-api=platform-api --role node-agent=node-agent --role web=web --role postgres=postgres \
  --role appliance-gateway=appliance-gateway --role maintenance-controller=maintenance-controller
```

`prepare` 先检查本机兼容性、卷已挂载且身份正确、Compose 的身份和镜像摘要，然后创建/验证内部网络。网络分配失败只清理本轮新建且无连接的网络。`apply` 不构建、不拉取未记录镜像，等待 Compose 健康后保存角色，并记录本机基线。已有安装再次执行只检查原角色，不隐式重建服务；更新使用下面的角色替换入口。

首次部署后，用 `appliance_https.py configure --installation … --configuration /etc/teamaibox/network-identity.json` 从 Web 实际挂载和 API 公共配置生成地址维护配置；可用 `--sfu-config` 明确提供本机 SFU 配置，须先导入 SFU 角色。升级保留原 CA、私钥和所有配置路径。手机使用 `prepare_portable_media.py --installation … --network-configuration … --patch-output …` 生成宿主状态引用及手机配置补丁；它不修改 ROM 或 guest。

将生成的补丁用下方 `appliance_delivery.py replace --role node-agent --image "$VERIFIED_AGENT_IMAGE_ID" --config-patch "$MEDIA_PATCH_FILE" --journal /var/lib/teamaibox-upgrades/phone-media-config.json` 应用到 Agent。即使镜像相同，尚未应用的配置也会精确更新 Agent；已经应用的同镜像/同配置则不重建。不能只生成补丁而漏掉这一步。先安装下面的宿主适配器并启动地址维护，再开放新手机创建。

安装启动适配器：

```sh
sudo python3 tools/install_portable_runtime.py --source tools --installation /etc/teamaibox/installation.json \
  --frontdoor-configuration /etc/teamaibox/frontdoor.json --journal-directory /var/lib/teamaibox-upgrades/host-adapters
sudo python3 tools/install_portable_storage.py --installation /etc/teamaibox/installation.json \
  --source tools/restore_existing_business_volumes.py --journal-directory /var/lib/teamaibox-upgrades/storage-adapter
sudo install -m 0644 deploy/host/teamaibox-existing-business-volumes.service /etc/systemd/system/
sudo install -m 0644 deploy/appliance/teamaibox-network-identity.service deploy/appliance/teamaibox-network-identity.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable teamaibox-existing-business-volumes.service teamaibox-frontdoor.service
sudo systemctl enable --now teamaibox-network-identity.timer
```

此处没有重启 Docker/主机的命令。新机在登记真实卷之前不要安装全局 Docker 挂载保护。旧机器保留已有保护；不要复制仓库中的开发卷 tmpfiles 排除项，安装器会从显式导入的旧卷根生成精确排除项。新部署使用持久目录。

## 已有安装导入与升级

先记录当前资源，指定本机真实 nodeId 和每个角色的完整容器 ID：

```sh
sudo python3 tools/appliance_delivery.py inventory --output /var/lib/teamaibox-upgrades/protected-before.json
sudo python3 tools/appliance_delivery.py import --node-id "$NODE_ID" \
  --role "platform-api=$API_CONTAINER_ID" --role "node-agent=$AGENT_CONTAINER_ID" \
  --role "web=$WEB_CONTAINER_ID" --role "postgres=$POSTGRES_CONTAINER_ID" --check
```

确认目标后去掉 `--check` 保存。变量必须来自该盒子的当前资源，不是开发机默认值。重复导入同一安装不变；身份冲突拒绝写入。公共配置和手机配置根据实际挂载自动转换为宿主路径，兼容正式 Compose 和旧布局。

旧卷可用 `import_installed_storage.py --help` 所示的显式旧适配器文件导入：只读取该文件的清单，先验证真实挂载/UUID/策略，再保存，不执行其中代码。网络用 `appliance_networks.py --installation … --env-output /etc/teamaibox/networks.env --import-network 角色=完整网络ID` 导入三个实际网络；已登记的 ID 或归属冲突会拒绝，现有连接不会 detach/reconnect。

```sh
sudo python3 tools/appliance_delivery.py replace --role node-agent \
  --image "$VERIFIED_IMAGE_ID" --journal /var/lib/teamaibox-upgrades/node-agent.json
sudo python3 tools/appliance_delivery.py resume --journal /var/lib/teamaibox-upgrades/node-agent.json
sudo python3 tools/appliance_delivery.py rollback --journal /var/lib/teamaibox-upgrades/node-agent.json
```

三条分别用于升级、中断续接和明确回退，不连续执行。使用已校验的本地 ARM64 镜像 ID；可用 `--config-patch` 提供“安装记录中的配置引用 → JSON 合并补丁”，只修改该配置。更新保留原环境、挂载、网络、安全/资源限制。目标健康且无关运行未变化后才更新角色记录；失败回到原组件。原组件保留为停止态供回退，不删除卷；不得用全量 Compose `down -v` 处理失败。同一镜像再次执行不替换容器。

正式 Compose 中，Agent、网关和维护控制器共用 API 的网络空间。导入时必须同时登记这些角色，API 更新时工具只把这些已登记的直接依赖组成一组，重建其连接并一同验证/回退；它们保留原镜像和挂载。发现未登记的依赖会在操作前停止，不能猜测归属。使用独立网络空间的旧安装仍只替换目标角色。整组回退后再次升级须使用新的日志文件，不覆盖原回退证据。

## 兼容性与维护

新机执行 `appliance_compatibility.py --installation … --contract deploy/host/release-compatibility.v1.json`，检查发行已验证的系统组合和必要能力，不比较开发机的全量软件/服务摘要。安装完成后，用本机基线执行 `host_drift.py check --allowlist /etc/teamaibox/host-baseline.json`。受控变更后仅用明确旧基线 SHA-256 的 `--replace-baseline-digest` 更新，旧基线保留；不会每次开机自动接受漂移。

远程共享维护工具要求显式 `TEAMAIBOX_APPLIANCE_SSH` 和 `TEAMAIBOX_POSTGRES_CONTAINER`；数据库操作还读取目标盒本机安装记录核对实际角色。可设置 `PLATFORM_APPLIANCE_NODE_ID` 增加预期身份约束。缺少目标不连接，身份不符不执行 SQL，模块导入没有连接副作用。不再回落到某个私网 IP 或日期化数据库名。

## 换网络

从盒子当前 IP 或本地可解析的 `<hostname>.local` 进入。跨 IP 可能需要登录盒子账户一次，不需要重新设置 Android/Google 账户。手机媒体地址和精确 TCP/UDP 端口转发由宿主维护器更新，新连接按已应用状态读取；无有效地址显示恢复中，不能冒用旧 IP。旧运行沿用原容器，新运行不绑定创建时 IP。地址维护失败只重试该路径，不重启 guest 或办公服务。

本次验收只覆盖相关安装/升级和地址变化；详见[修复证据](../validation/portable-appliance-delivery-20261024.md)，不重新要求投屏、Google 商店或系统安装验收。
