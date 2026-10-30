# 单盒 Windows ARM64 开发

当前只使用一台设备的 KVM。运行位置来自 `PLATFORM_APPLIANCE_NODE_ID`，不由客户端选择。

- Windows 11 ARM64 的当前成员桌面与数据恢复流程已验证；新建电脑仍需安装 Windows，并非预装成品。Windows 10 ARM64 当前不提供，23.10 以明确的介质/权利缺失记录关闭，不是兼容性通过。
- 客体系统盘、固件与虚拟 TPM 数据独立持久化；页面、API 或运行管理服务更新不得重建账户和磁盘。
- CPU、内存、编解码和网络由操作系统共享，不提前预占；真实分配或运行失败直接说明原因。
- 浏览器入口是 `/apps/virtual-computers`。用户可选择控制台或远程桌面；原生管理端口不直接公开。
- 安装测试保留原系统数据；所有破坏性重装仅针对明确获准的电脑。
- 本机部署配置位于 `deploy/appliance`，设备管理位于 `/admin/device`。

当前使用步骤见 [虚拟电脑指南](virtual-computers-user-guide.md)，完成依据、介质/远程使用/分发边界和一次性交付确认见 [交付汇总](validation/single-appliance-delivery-20261019.md)。现有 Windows 测试档案标明不允许镜像再分发；不将测试 guest、账户或产品密钥打包给客户。此前具体构建、安装与调试过程保留在 [历史记录](validation/windows-arm64-development-before-single-appliance-20261016.md)，不作为新部署的自动通过结论，也不重新产生当前待测任务。

