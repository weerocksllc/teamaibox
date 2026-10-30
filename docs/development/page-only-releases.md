# 页面独立发布

页面的 HTML、CSS、JavaScript 更新只替换对应的页面插件容器，不重建或重启 Platform API、节点管理服务、Android 手机或投屏接收器。

## 日常发布

1. 构建并测试对应页面，生成新的页面构建记录。
2. 使用已有发布者配置准备页面包。不要重新生成密钥，也不要调用后台部署工具。
3. 通过正常插件安装接口导入并升级页面版本。
4. 打开真实页面检查；核对后台和原手机容器、启动时间不变。

虚拟手机页面准备命令（运行编号按本次发布填写，不能重用已存在编号）：

```sh
TEAMAIBOX_PLUGIN_PUBLISHER_FILE=deploy/appliance/virtual-phones-publisher.local.json \
python3 tools/prepare_phone_ui_recovery.py --ui-only \
  --build-run-id virtual-phones-ui-release-YYYYMMDD-aN \
  --run-id virtual-phones-ui-preparation-YYYYMMDD-aN

python3 tools/upgrade_phone_ui_protocol.py \
  --preparation evidence/validation/feature-deployments/virtual-phones-ui-preparation-YYYYMMDD-aN.json \
  --version 0.1.N --run-id phone-ui-protocol-install-YYYYMMDD-aN
```

安装命令从标准输入读取一行管理员登录 JSON；不要将密码写入仓库、脚本或命令行参数。也可以使用已登录的插件管理接口完成相同步骤。

无线投屏页面使用 `prepare_wireless_casting_ui.py`，发布者配置为 `wireless-casting-publisher.local.json`。该工具同样只准备页面，不更新接收器或后台。历史 `prepare_casting_*_ui.py` / `deploy_casting_*_ui_trust*` 是旧部署记录对应工具，不作为新的页面发布入口。

旧 `prepare_phone_ui_release.py`、`deploy_phone_theme_ui.py` 和 `deploy_phone_reconnect_ui.py` 的执行入口已经停用；保留导入函数是为了兼容历史验证，不表示可以继续用它们发布页面。

## 只需执行一次的配置迁移

当前主盒已完成 `phone-platform-20260915-a6`：公钥配置改为读取现有持久卷里的 `/var/lib/teamaibox-plugin-source/current/plugin-source-catalog.json`。这次迁移保留相同的后台程序镜像，但更换了主盒控制容器；辅助节点服务和原 Android 手机没有重启。日常页面更新不能再次调用迁移。

固定发布者由 `stage_plugin_publisher.py` 注册。私钥仅在主盒现有 LUKS2 文件系统中保存；本地 `.local.json` 只有公钥和远程签名命令，不含私钥。该脚本包含当前开发盒的精确存储位置，不是通用新盒安装器；新盒须使用自己的持久加密存储和发布者配置。

保留安装包签名、权限和 HTTPS 校验。区别是同一发布者长期复用，不再每改一次页面就更换身份、修改后台镜像。后台已有的动态配置读取能力不要求服务重启。

## 更新失败和回退

已有插件生命周期代码会在新页面健康检查失败时恢复旧页面；本轮通过了对应源码测试，没有故意让线上页面失败。已成功安装后，接口目前不支持直接安装更低版本号。需要撤销某次视觉改动时，将原页面内容作为新的补丁版本发布，仅更新页面，不回退后台、ROM 或手机数据。

## 本次实际验证

- 页面版本：虚拟手机 0.1.10，正常 HTTPS 导入和升级成功。
- 准备记录：`virtual-phones-ui-preparation-20260915-a3`；安装记录：`phone-ui-protocol-install-20260915-a2`。
- 实际只替换一个页面容器；其余本机服务、手机记录和管理状态保持不变，原手机 `ooo` 继续运行。
- 明暗主题及 390px 窄屏已在主盒实际页面检查，技术实现名称不再显示。
- 最初按容器名称分类的检查误把页面容器当作其他服务，失败记录 `phone-ui-independent-update-20260915-a1` 保留。`validate_phone_ui_update.py` 按相同更新的确切镜像、容器身份重新检查并通过；不是重新安装，也没有改写原失败记录。
- 无线投屏独立准备工具和固定发布者配置已完成；本轮没有重新发布投屏页面或停止接收器。

这项结果不代表辅助节点真正断线后的手机恢复缺陷已修复，也不替代摄像头、压力或完整发布验收。

